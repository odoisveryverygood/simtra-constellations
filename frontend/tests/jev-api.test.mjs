import test from "node:test";
import assert from "node:assert/strict";
import { abTest, poll, parseQuestion } from "../src/api.js";
const originalFetch = globalThis.fetch;
test('Jev is scoped to A/B; explicit prediction models remain intact', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({url,body:JSON.parse(options.body)});
    return new Response(JSON.stringify({model:JSON.parse(options.body).model}));
  };
  try {
    assert.equal((await abTest('branch', {question:'Compare'})).model,'jev-latest');
    await abTest('branch',{model:'gemini-3.5-flash'});
    await poll('branch',{model:'gemini-3.5-flash'});
    await parseQuestion('sf','Question');
    assert.equal(calls[1].body.model,'gemini-3.5-flash');
    assert.equal(calls[2].body.model,'gemini-3.5-flash');
    assert.notEqual(calls[3].body.model,'jev-latest');
  } finally { globalThis.fetch = originalFetch; }
});
test('missing routes, keys and budget failures propagate without mock success',async () => {
  try {
    for (const [status,message] of [[404,'branch not found'],[502,'TYPESAFE_API_KEY not set'],[502,'Jev comparison exceeds the three-batch budget (36 archetypes)']]) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({error:message}),{status}); };
      await assert.rejects(abTest('branch',{}),error => error.status === status && error.message.includes(message));
      assert.equal(calls,1);
    }
  } finally { globalThis.fetch = originalFetch; }
});
