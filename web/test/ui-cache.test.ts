import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANALYST_BROWSER_CACHE_TTL_MS,
  SPOT_BROWSER_CACHE_TTL_MS,
} from "../app/UniverseTable";

test("browser cache TTLs are layered by data volatility", () => {
  assert.equal(SPOT_BROWSER_CACHE_TTL_MS, 15 * 60 * 1000);
  assert.equal(ANALYST_BROWSER_CACHE_TTL_MS, 24 * 60 * 60 * 1000);
  assert.ok(ANALYST_BROWSER_CACHE_TTL_MS > SPOT_BROWSER_CACHE_TTL_MS);
});
