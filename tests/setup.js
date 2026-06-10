// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import "@testing-library/jest-dom";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// V22-bug-pass-3 — with `vitest --pool=threads --poolOptions.threads.singleThread`
// (npm test), test files share a single jsdom instance across the whole
// run. Without explicit cleanup, components rendered by one test stay in
// the DOM and contaminate `getByText` / `querySelectorAll` calls in later
// tests, causing "Found multiple elements" failures. cleanup() unmounts
// everything between tests; it's a no-op when each test already mounts
// fresh in its own jsdom (multi-pool runs).
afterEach(function() { cleanup(); });
