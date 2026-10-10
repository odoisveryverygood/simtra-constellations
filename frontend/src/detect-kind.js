// What kind of thing a resident is being told: news, policy, incident, or rumor.
// A small word list is enough here; the kind only labels the memory entry.
export const KINDS = ["news", "policy", "incident", "rumor"];

const RUMOR = /\b(reportedly|rumou?rs?|sources say|allegedly|unconfirmed|might|may be|could be)\b/i;
const INCIDENT = /\b(shot|shooting|stabb(?:ed|ing)|earthquake|quake|fire|wildfire|crash(?:ed|es)?|collision|flood(?:ed|ing)?|attack(?:ed)?|explosion|exploded|blast|outage|blackout|killed|injured|dead|deaths?|evacuat(?:ed|ion)|derail(?:ed|ment)|collapse[ds]?)\b/i;
const POLICY = /\b(announce[sd]?|bill|ordinance|measure|passes|passed|approve[sd]?|council|supervisors?|mayor|governor|budget|tax(?:es)?|ban(?:s|ned)?|law|legislation|policy|proposal|proposes?d?|vote[sd]?|regulation|mandate[sd]?|fee|fare)\b/i;

export function detectKind(text) {
  const t = String(text || "").trim();
  if (!t) return "news";
  if (RUMOR.test(t)) return "rumor";
  if (INCIDENT.test(t)) return "incident";
  if (POLICY.test(t)) return "policy";
  return "news";
}

export function nextKind(kind) {
  return KINDS[(KINDS.indexOf(kind) + 1) % KINDS.length];
}
