import test from "node:test";
import assert from "node:assert/strict";
import { snapshotAudience, describeAudience, audienceHeader, audienceScope } from "./audience.js";

const city = { display: "San Francisco", neighborhoods: [{ puma: 7511, label: "Bernal Heights / the central city" }] };

test("a result preserves its audience when the current filters change", () => {
  const filters = { age: 30, puma: 7511, occupation: "engineer", education: "bachelors" };
  const audience = snapshotAudience({ city, filters, sourceRecords: 1, residents: 10000 });
  filters.age = 25;
  const info = describeAudience(audience);
  assert.equal(info.title, "30-year-old engineers");
  assert.equal(info.qualification, "With a bachelor's degree");
  assert.equal(info.location, "Bernal Heights / the central city · San Francisco");
  assert.equal(info.filterCount, 4);
  assert.equal(audienceScope(audience), "Percentages within this filtered audience");
});

test("generated sample size stays separate from the available source records", () => {
  const audience = snapshotAudience({ city, filters: { age: 30 }, sourceRecords: 1, residents: 10000 });
  const html = audienceHeader(audience, 600);
  assert.match(html, /<strong>600<\/strong>/);
  assert.match(html, /<strong>1<\/strong>/);
  assert.match(html, /one matching Census record/);
  assert.doesNotMatch(html, /10,000/);
});

test("whole-city and partial filters describe only the selected traits", () => {
  const all = snapshotAudience({ city, residents: 10000 });
  assert.equal(describeAudience(all).label, "Whole-city audience");
  assert.equal(describeAudience(all).title, "San Francisco residents");
  assert.equal(audienceScope(all), "Percentages within this city sample");
  const educationOnly = snapshotAudience({ city, filters: { education: "bachelors" } });
  assert.equal(describeAudience(educationOnly).title, "Residents");
  assert.equal(describeAudience(educationOnly).location, "Across San Francisco");
  const ageZero = snapshotAudience({ city, filters: { age: 0 } });
  assert.equal(describeAudience(ageZero).title, "0-year-old residents");
});

test("missing source metadata is unavailable, never a fabricated source count", () => {
  const audience = snapshotAudience({ city, residents: 10000 });
  assert.match(audienceHeader(audience, 10000), /Unavailable/);
  assert.doesNotMatch(audienceHeader(audience, 10000), /one matching/);
  assert.match(audienceHeader(null, 600), /Audience definition unavailable/);
});

test("API-provided geography is escaped in the result header", () => {
  const audience = snapshotAudience({ city: { display: '<img src=x onerror="alert(1)">' }, residents: 10 });
  const html = audienceHeader(audience, 10);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});
