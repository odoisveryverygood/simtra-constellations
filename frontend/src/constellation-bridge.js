// Integration owns lifecycle only. Rendering belongs to A; grouping belongs to B.
export function createConstellationBridge({ map, state, loadRenderer, loadModel, onChange = () => {} }) {
  let renderer, buildModel, loading, active = false, busy = false, operation = 0;
  let result = null;
  function announce(message = '') { onChange({ active, busy, message }); }
  async function prepare() {
    if (renderer) return;
    if (!loading) loading = Promise.all([loadRenderer(), loadModel()]).then(([view, model]) => {
      if (typeof view.initConstellations !== 'function' || typeof model.buildConstellationModel !== 'function') {
        throw new Error('Invalid constellation module contract');
      }
      const candidate = view.initConstellations(map, state);
      if (!candidate || ['setActive','setResult','destroy'].some(k => typeof candidate[k] !== 'function')) {
        candidate?.destroy?.(); throw new Error('Invalid renderer lifecycle');
      }
      renderer = candidate; buildModel = model.buildConstellationModel;
    }).finally(() => { loading = null; });
    await loading;
  }
  function syncResult() {
    if (!renderer) return;
    const model = result ? buildModel(state.rawResidents, result) : null;
    // B returns structured provenance; A accepts a display string and mock flag.
    const displayModel = model && typeof model.provenance === 'object' && model.provenance
      ? { ...model, mock: model.mock === true || model.provenance.mode === 'fixture', provenance: model.provenance.label || null }
      : model;
    renderer.setResult(displayModel);
  }
  function restore() {
    try { renderer?.setActive(false); } catch { /* city restoration is unconditional */ }
    active = false;
  }
  return {
    async setActive(next) {
      const request = ++operation;
      if (!next) { restore(); busy = false; announce(); return false; }
      if (!state.rawResidents.length || state.switching || state.phase === 'booting' || state.phase === 'error') {
        announce('Let the city finish loading before opening constellations.'); return false;
      }
      busy = true; announce();
      try {
        await prepare();
        if (request !== operation) return false;
        syncResult();
        await renderer.setActive(true);
        if (request !== operation) { restore(); return false; }
        active = true; announce(); return true;
      } catch (error) {
        if (request !== operation) return false;
        restore();
        console.warn('Constellation view unavailable:', error);
        announce('Constellations are not available yet. Your city stays open.');
        return false;
      } finally { if (request === operation) { busy = false; announce(); } }
    },
    setResult(next) {
      result = next;
      try { syncResult(); } catch (error) {
        console.warn('Constellation result unavailable:', error); restore();
        announce('This result could not be connected. Your city stays open.');
      }
    },
    reset() { ++operation; result = null; busy = false; restore();
      try { renderer?.setResult(null); } catch { /* no old result survives in the city */ }
      announce();
    },
    destroy() { ++operation; restore(); renderer?.destroy(); renderer = null; result = null; busy = false; announce(); },
  };
}
