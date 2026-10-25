import { afterEach, inject } from "vite-plus/test";

import { assertSharedTreeUnchanged } from "../helpers/packageFixtureIsolation.js";

// Every package file shares one fixture across parallel workers. Fail the test
// that observes a change so an in-place mutation cannot pass as a peer's flake.
const fixture = inject("packageFixture");
const stamp = inject("packageFixtureStamp");

afterEach(() => {
  assertSharedTreeUnchanged(stamp, [fixture.packageRoot, fixture.constructionRoot]);
});
