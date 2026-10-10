//! Snapshot + branch persistence (sqlite `state.db`).
//!
//! Tables:
//!   simulations(id, seed, n, start_datetime, tick_seconds, commit_every, static_blob)
//!   snapshots(id INTEGER PK, sim_id, branch_id, parent_id, tick, label, state_hash, blob)
//!   branches(id, sim_id, name, kind, head_snapshot, base_snapshot, clock, tick, status)
//!
//! Static layer is stored once per simulation (`static_blob`); snapshots hold only the
//! mutable `SimState`, so they stay small at 20k agents. Branch operations clone a
//! parent snapshot's mutable state into a new branch and never touch main.

use crate::state::SimState;
use anyhow::{anyhow, ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::sync::Mutex;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SimMeta {
    pub seed: u64,
    pub n: usize,
    pub start_datetime: String,
    pub tick_seconds: i64,
    pub commit_every: u64,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct BranchInfo {
    pub id: String,
    pub sim_id: String,
    pub name: String,
    pub kind: String,
    pub head_snapshot: i64,
    pub base_snapshot: Option<i64>,
    pub clock_secs: i64,
    pub tick: u64,
    pub status: String,
}

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &str) -> Result<Self> {
        let conn = Connection::open(path).with_context(|| format!("open state db {path}"))?;
        Self::init(&conn)?;
        Ok(Store { conn: Mutex::new(conn) })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::init(&conn)?;
        Ok(Store { conn: Mutex::new(conn) })
    }

    fn init(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS simulations (
                id TEXT PRIMARY KEY, seed INTEGER, n INTEGER, start_datetime TEXT,
                tick_seconds INTEGER, commit_every INTEGER, static_blob TEXT, created INTEGER);
             CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT, sim_id TEXT, branch_id TEXT,
                parent_id INTEGER, tick INTEGER, label TEXT, state_hash TEXT, blob TEXT);
             CREATE TABLE IF NOT EXISTS branches (
                id TEXT PRIMARY KEY, sim_id TEXT, name TEXT, kind TEXT,
                head_snapshot INTEGER, base_snapshot INTEGER, clock_secs INTEGER,
                tick INTEGER, status TEXT);
             CREATE INDEX IF NOT EXISTS idx_snap_branch ON snapshots(branch_id);
             CREATE TABLE IF NOT EXISTS competition_runs (
                workspace TEXT NOT NULL, request_id TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
                result_json TEXT, created INTEGER NOT NULL,
                PRIMARY KEY(workspace, request_id));",
        )?;
        Ok(())
    }

    /// Reserve a comparison before any model calls. Failed or interrupted requests
    /// remain reserved: retrying must not silently incur another paid evaluation.
    pub fn competition_begin(&self, workspace: &str, request_id: &str, request_hash: &str) -> Result<Option<serde_json::Value>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous: Option<(String, String, Option<String>)> = tx.query_row(
            "SELECT request_hash, status, result_json FROM competition_runs WHERE workspace=?1 AND request_id=?2",
            params![workspace, request_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        if let Some((hash, status, result)) = previous {
            ensure!(hash == request_hash, "Request ID already belongs to different comparison inputs");
            ensure!(status == "completed", "Comparison is running, failed, or was interrupted; it will not be automatically retried");
            let value = serde_json::from_str(&result.context("Completed comparison has no saved result")?)?;
            tx.commit()?;
            return Ok(Some(value));
        }
        tx.execute(
            "INSERT INTO competition_runs (workspace, request_id, request_hash, status, created) VALUES (?1,?2,?3,'running',strftime('%s','now'))",
            params![workspace, request_id, request_hash],
        )?;
        tx.commit()?;
        Ok(None)
    }

    pub fn competition_finish(&self, workspace: &str, request_id: &str, result: Option<&serde_json::Value>) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let serialized = result.map(serde_json::to_string).transpose()?;
        let status = if result.is_some() { "completed" } else { "failed" };
        let changed = conn.execute(
            "UPDATE competition_runs SET status=?1, result_json=?2 WHERE workspace=?3 AND request_id=?4 AND status='running'",
            params![status, serialized, workspace, request_id],
        )?;
        ensure!(changed == 1, "No pending comparison exists for this workspace and request ID");
        Ok(())
    }

    pub fn competition_runs(&self, workspace: &str) -> Result<Vec<serde_json::Value>> {
        let conn = self.conn.lock().unwrap();
        let mut statement = conn.prepare(
            "SELECT result_json FROM competition_runs WHERE workspace=?1 AND status='completed' ORDER BY created DESC, request_id",
        )?;
        let rows = statement.query_map([workspace], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    /// Create a simulation with its static layer and a `main` branch + initial snapshot.
    pub fn create_sim(&self, sim_id: &str, meta: &SimMeta, static_blob: &str, init: &SimState) -> Result<String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO simulations (id, seed, n, start_datetime, tick_seconds, commit_every, static_blob, created)
             VALUES (?1,?2,?3,?4,?5,?6,?7, strftime('%s','now'))",
            params![sim_id, meta.seed as i64, meta.n as i64, meta.start_datetime, meta.tick_seconds, meta.commit_every as i64, static_blob],
        )?;
        let main_id = format!("{sim_id}:main");
        conn.execute(
            "INSERT INTO branches (id, sim_id, name, kind, head_snapshot, base_snapshot, clock_secs, tick, status)
             VALUES (?1,?2,'main','main',0,NULL,?3,?4,'ready')",
            params![main_id, sim_id, init.clock_secs, init.tick as i64],
        )?;
        let snap = Self::commit_inner(&conn, sim_id, &main_id, None, init, "init")?;
        conn.execute("UPDATE branches SET head_snapshot=?1 WHERE id=?2", params![snap, main_id])?;
        Ok(main_id)
    }

    fn commit_inner(
        conn: &Connection,
        sim_id: &str,
        branch_id: &str,
        parent: Option<i64>,
        state: &SimState,
        label: &str,
    ) -> Result<i64> {
        let mut c = state.clone();
        c.canonicalize();
        let hash = c.state_hash();
        let blob = c.to_canonical_json();
        conn.execute(
            "INSERT INTO snapshots (sim_id, branch_id, parent_id, tick, label, state_hash, blob)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![sim_id, branch_id, parent, c.tick as i64, label, hash, blob],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Commit a new snapshot on a branch, advancing its head. Returns snapshot id.
    pub fn commit(&self, sim_id: &str, branch_id: &str, state: &SimState, label: &str) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let parent: Option<i64> = conn
            .query_row("SELECT head_snapshot FROM branches WHERE id=?1", [branch_id], |r| r.get(0))
            .ok();
        let snap = Self::commit_inner(&conn, sim_id, branch_id, parent, state, label)?;
        conn.execute(
            "UPDATE branches SET head_snapshot=?1, clock_secs=?2, tick=?3 WHERE id=?4",
            params![snap, state.clock_secs, state.tick as i64, branch_id],
        )?;
        Ok(snap)
    }

    pub fn load_snapshot(&self, snapshot_id: i64) -> Result<SimState> {
        let conn = self.conn.lock().unwrap();
        let blob: String = conn
            .query_row("SELECT blob FROM snapshots WHERE id=?1", [snapshot_id], |r| r.get(0))
            .with_context(|| format!("snapshot {snapshot_id} not found"))?;
        Ok(serde_json::from_str(&blob)?)
    }

    pub fn snapshot_hash(&self, snapshot_id: i64) -> Result<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT state_hash FROM snapshots WHERE id=?1", [snapshot_id], |r| r.get(0))
            .map_err(|e| anyhow!(e))
    }

    pub fn branch_head(&self, branch_id: &str) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT head_snapshot FROM branches WHERE id=?1", [branch_id], |r| r.get(0))
            .map_err(|e| anyhow!("branch {branch_id}: {e}"))
    }

    pub fn main_branch(&self, sim_id: &str) -> String {
        format!("{sim_id}:main")
    }

    pub fn get_static(&self, sim_id: &str) -> Result<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT static_blob FROM simulations WHERE id=?1", [sim_id], |r| r.get(0))
            .map_err(|e| anyhow!("sim {sim_id}: {e}"))
    }

    /// Create a branch off a parent snapshot, cloning its mutable state. Does not mutate main.
    pub fn create_branch(&self, sim_id: &str, from_snapshot: i64, branch_id: &str, name: &str) -> Result<BranchInfo> {
        let state = self.load_snapshot(from_snapshot)?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO branches (id, sim_id, name, kind, head_snapshot, base_snapshot, clock_secs, tick, status)
             VALUES (?1,?2,?3,'branch',0,?4,?5,?6,'running')",
            params![branch_id, sim_id, name, from_snapshot, state.clock_secs, state.tick as i64],
        )?;
        // clone the parent state as the branch's first snapshot
        let snap = Self::commit_inner(&conn, sim_id, branch_id, Some(from_snapshot), &state, "branch-base")?;
        conn.execute("UPDATE branches SET head_snapshot=?1 WHERE id=?2", params![snap, branch_id])?;
        Ok(BranchInfo {
            id: branch_id.to_string(),
            sim_id: sim_id.to_string(),
            name: name.to_string(),
            kind: "branch".into(),
            head_snapshot: snap,
            base_snapshot: Some(from_snapshot),
            clock_secs: state.clock_secs,
            tick: state.tick,
            status: "running".into(),
        })
    }

    pub fn branch_info(&self, branch_id: &str) -> Result<BranchInfo> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, sim_id, name, kind, head_snapshot, base_snapshot, clock_secs, tick, status
             FROM branches WHERE id=?1",
            [branch_id],
            |r| {
                Ok(BranchInfo {
                    id: r.get(0)?,
                    sim_id: r.get(1)?,
                    name: r.get(2)?,
                    kind: r.get(3)?,
                    head_snapshot: r.get(4)?,
                    base_snapshot: r.get(5)?,
                    clock_secs: r.get(6)?,
                    tick: r.get::<_, i64>(7)? as u64,
                    status: r.get(8)?,
                })
            },
        )
        .map_err(|e| anyhow!("branch {branch_id}: {e}"))
    }

    pub fn set_branch_status(&self, branch_id: &str, status: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE branches SET status=?1 WHERE id=?2", params![status, branch_id])?;
        Ok(())
    }

    pub fn delete_branch(&self, branch_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM snapshots WHERE branch_id=?1", [branch_id])?;
        conn.execute("DELETE FROM branches WHERE id=?1", [branch_id])?;
        Ok(())
    }

    /// Reset the active session to main HEAD: returns the main head state (unchanged).
    pub fn reset_to_main(&self, sim_id: &str) -> Result<SimState> {
        let head = self.branch_head(&self.main_branch(sim_id))?;
        self.load_snapshot(head)
    }

    pub fn list_branches(&self, sim_id: &str) -> Result<Vec<BranchInfo>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, sim_id, name, kind, head_snapshot, base_snapshot, clock_secs, tick, status
             FROM branches WHERE sim_id=?1",
        )?;
        let rows = stmt.query_map([sim_id], |r| {
            Ok(BranchInfo {
                id: r.get(0)?,
                sim_id: r.get(1)?,
                name: r.get(2)?,
                kind: r.get(3)?,
                head_snapshot: r.get(4)?,
                base_snapshot: r.get(5)?,
                clock_secs: r.get(6)?,
                tick: r.get::<_, i64>(7)? as u64,
                status: r.get(8)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::ValueVector;
    use crate::geo::Cell;
    use crate::state::{AgentState, SimState};

    #[test]
    fn competition_result_survives_reopen_and_replay() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.db");
        let path = path.to_str().unwrap();
        let result = serde_json::json!({"id":"comparison-1","baseline":{"share":0.4}});
        {
            let store = Store::open(path).unwrap();
            assert!(store.competition_begin("workspace-a", "request-1", "hash-a").unwrap().is_none());
            assert!(store.competition_begin("workspace-a", "request-1", "hash-a").is_err());
            store.competition_finish("workspace-a", "request-1", Some(&result)).unwrap();
        }
        let store = Store::open(path).unwrap();
        assert_eq!(store.competition_begin("workspace-a", "request-1", "hash-a").unwrap(), Some(result.clone()));
        assert_eq!(store.competition_runs("workspace-a").unwrap(), vec![result]);
        assert!(store.competition_begin("workspace-a", "request-1", "different-inputs").is_err());
    }

    #[test]
    fn competition_results_are_workspace_scoped() {
        let store = Store::open_in_memory().unwrap();
        let result = serde_json::json!({"id":"private-comparison"});
        store.competition_begin("a", "same-id", "hash-a").unwrap();
        store.competition_finish("a", "same-id", Some(&result)).unwrap();
        assert!(store.competition_runs("b").unwrap().is_empty());
        assert!(store.competition_begin("b", "same-id", "hash-b").unwrap().is_none());
        assert!(store.competition_finish("b", "missing", Some(&result)).is_err());
        assert_eq!(store.competition_runs("a").unwrap(), vec![result]);
    }

    #[test]
    fn competition_failure_cannot_silently_retry_or_overwrite() {
        let store = Store::open_in_memory().unwrap();
        store.competition_begin("a", "failed-id", "hash").unwrap();
        store.competition_finish("a", "failed-id", None).unwrap();
        assert!(store.competition_begin("a", "failed-id", "hash").is_err());
        assert!(store.competition_finish("a", "failed-id", Some(&serde_json::json!({}))).is_err());
        assert!(store.competition_runs("a").unwrap().is_empty());
    }

    #[test]
    fn competition_reservation_is_atomic_across_connections() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.db");
        let stores = [Store::open(path.to_str().unwrap()).unwrap(), Store::open(path.to_str().unwrap()).unwrap()];
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let threads: Vec<_> = stores.into_iter().map(|store| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store.competition_begin("a", "same-id", "hash").is_ok()
            })
        }).collect();
        let successes = threads.into_iter().filter_map(|thread| thread.join().ok()).filter(|success| *success).count();
        assert_eq!(successes, 1);
    }

    fn vv() -> ValueVector {
        ValueVector {
            economic: -0.3, social: -0.4, trust: 0.0, change: 0.1,
            s_housing: 0.7, s_crime: 0.5, s_homeless: 0.6, s_cost: 0.7,
            s_environment: 0.6, s_immigration: 0.3,
        }
    }
    fn state(tick: u64) -> SimState {
        SimState {
            tick,
            clock_secs: tick as i64 * 30,
            agents: vec![
                AgentState { id: 0, pos: Cell::new(3, 4), action: "idle".into(), values: vv(), alive: true, memory: vec![] },
                AgentState { id: 1, pos: Cell::new(10, 20), action: "walk".into(), values: vv(), alive: true, memory: vec![] },
            ],
            relationships: vec![],
        }
    }

    #[test]
    fn commit_restore_roundtrip_bitforbit() {
        let s = Store::open_in_memory().unwrap();
        let meta = SimMeta { seed: 1, n: 2, start_datetime: "2024-01-01T00:00:00".into(), tick_seconds: 30, commit_every: 10 };
        s.create_sim("sim1", &meta, "{}", &state(0)).unwrap();
        let snap = s.commit("sim1", "sim1:main", &state(7), "t7").unwrap();
        let loaded = s.load_snapshot(snap).unwrap();
        let mut want = state(7);
        want.canonicalize();
        assert_eq!(loaded, want);
        assert_eq!(loaded.state_hash(), want.state_hash());
    }

    #[test]
    fn branch_does_not_mutate_main() {
        let s = Store::open_in_memory().unwrap();
        let meta = SimMeta { seed: 1, n: 2, start_datetime: "x".into(), tick_seconds: 30, commit_every: 10 };
        s.create_sim("sim1", &meta, "{}", &state(0)).unwrap();
        let main_head = s.branch_head("sim1:main").unwrap();
        let main_hash_before = s.snapshot_hash(main_head).unwrap();

        // branch off main head, then mutate the branch heavily
        let br = s.create_branch("sim1", main_head, "sim1:b1", "what-if").unwrap();
        let mut bs = s.load_snapshot(br.head_snapshot).unwrap();
        bs.tick = 99;
        bs.agents[0].pos = Cell::new(123, 234);
        bs.agents[0].action = "panic".into();
        s.commit("sim1", "sim1:b1", &bs, "mutated").unwrap();

        // main head unchanged
        let main_head_after = s.branch_head("sim1:main").unwrap();
        assert_eq!(main_head, main_head_after);
        assert_eq!(main_hash_before, s.snapshot_hash(main_head_after).unwrap());
        let main_state = s.load_snapshot(main_head_after).unwrap();
        assert_eq!(main_state.tick, 0);
        assert_eq!(main_state.agents[0].pos, Cell::new(3, 4));
    }

    #[test]
    fn reset_to_main_restores_exact_hash() {
        let s = Store::open_in_memory().unwrap();
        let meta = SimMeta { seed: 1, n: 2, start_datetime: "x".into(), tick_seconds: 30, commit_every: 10 };
        s.create_sim("sim1", &meta, "{}", &state(0)).unwrap();
        // advance main a few commits
        s.commit("sim1", "sim1:main", &state(1), "t1").unwrap();
        let head = s.commit("sim1", "sim1:main", &state(2), "t2").unwrap();
        let head_hash = s.snapshot_hash(head).unwrap();

        // branch + mutate + delete
        let br = s.create_branch("sim1", head, "sim1:b1", "wf").unwrap();
        let mut bs = s.load_snapshot(br.head_snapshot).unwrap();
        bs.agents[1].alive = false;
        s.commit("sim1", "sim1:b1", &bs, "kill").unwrap();
        s.delete_branch("sim1:b1").unwrap();

        // reset returns main head, exact hash
        let restored = s.reset_to_main("sim1").unwrap();
        assert_eq!(restored.state_hash(), head_hash);
        assert_eq!(restored.tick, 2);
        assert!(restored.agents.iter().all(|a| a.alive));
    }
}
