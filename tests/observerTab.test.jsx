// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ObserverTab } from "../src/react/components/observerTab.jsx";

describe("ObserverTab", function() {
  beforeEach(function() {
    // Clean localStorage between tests so they don't interact
    if (typeof localStorage !== "undefined") localStorage.clear();
  });

  it("shows 'observer is disabled' when config.observerEnabled is false", function() {
    const { container } = render(<ObserverTab config={{ observerEnabled: false }} />);
    expect(container.textContent).toMatch(/Observer is disabled/);
    expect(container.textContent).toMatch(/Workflow Settings → Observer Agent/);
  });

  it("shows the empty-state message when enabled but no events", function() {
    const { container } = render(<ObserverTab config={{ observerEnabled: true, workflow: "rtl" }} />);
    expect(container.textContent).toMatch(/No observations yet/);
    expect(container.textContent).toMatch(/Run a stage with the observer enabled/);
  });

  it("renders events from localStorage", function() {
    // Pre-seed localStorage with one observer event
    const event = {
      ts: Date.now(),
      workflow: "rtl",
      stage_key: "verify",
      event_kind: "error",
      severity: "warn",
      flag_dismissed: 0,
      extracted: {
        summary: "TB regen failed due to unbound parameter width",
        tags: ["width-mismatch", "param-binding"],
        actionable: true,
      },
    };
    localStorage.setItem("rtlforge:obs:rtl:1234567890:abcd", JSON.stringify(event));

    const { container } = render(<ObserverTab config={{ observerEnabled: true, workflow: "rtl" }} />);
    expect(container.textContent).toMatch(/TB regen failed due to unbound parameter width/);
    expect(container.textContent).toMatch(/width-mismatch/);
    expect(container.textContent).toMatch(/param-binding/);
    expect(container.textContent).toMatch(/Actionable/);
    // Tags show the kind label
    expect(container.textContent).toMatch(/Error/);
  });

  it("dismiss button hides an event from default view", function() {
    const event = {
      ts: Date.now(),
      workflow: "rtl",
      stage_key: "lint",
      event_kind: "error",
      severity: "info",
      flag_dismissed: 0,
      extracted: { summary: "something happened", tags: [] },
    };
    const key = "rtlforge:obs:rtl:9999999999:xyz";
    localStorage.setItem(key, JSON.stringify(event));

    const { container, getByText } = render(<ObserverTab config={{ observerEnabled: true, workflow: "rtl" }} />);
    expect(container.textContent).toMatch(/something happened/);
    fireEvent.click(getByText("Dismiss"));
    // After dismiss, the event should disappear from default view
    expect(container.textContent).not.toMatch(/something happened/);
    // localStorage entry still exists but flag_dismissed = 1
    const stored = JSON.parse(localStorage.getItem(key));
    expect(stored.flag_dismissed).toBe(1);
  });

  it("delete button removes the event from localStorage", function() {
    const event = {
      ts: Date.now(),
      workflow: "rtl",
      stage_key: "lint",
      event_kind: "error",
      severity: "info",
      flag_dismissed: 0,
      extracted: { summary: "delete me", tags: [] },
    };
    const key = "rtlforge:obs:rtl:5555555555:zzz";
    localStorage.setItem(key, JSON.stringify(event));

    const { container, getByText } = render(<ObserverTab config={{ observerEnabled: true, workflow: "rtl" }} />);
    expect(container.textContent).toMatch(/delete me/);
    fireEvent.click(getByText("Delete"));
    expect(container.textContent).not.toMatch(/delete me/);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("'show dismissed' checkbox reveals dismissed events with the dismissed badge", function() {
    const event = {
      ts: Date.now(),
      workflow: "rtl",
      stage_key: "verify",
      event_kind: "fix",
      severity: "info",
      flag_dismissed: 1,                       // already dismissed
      extracted: { summary: "old fix", tags: [] },
    };
    localStorage.setItem("rtlforge:obs:rtl:7777777777:aaa", JSON.stringify(event));

    const { container, getByLabelText } = render(<ObserverTab config={{ observerEnabled: true, workflow: "rtl" }} />);
    // Default: hidden
    expect(container.textContent).not.toMatch(/old fix/);
    // Toggle "show dismissed"
    fireEvent.click(getByLabelText(/Show dismissed/i));
    expect(container.textContent).toMatch(/old fix/);
    expect(container.textContent).toMatch(/dismissed/);  // badge
  });

  it("scopes events by workflow column (per-workflow scoping)", function() {
    // Two events for different workflows
    localStorage.setItem("rtlforge:obs:rtl:1:a", JSON.stringify({
      ts: Date.now(), workflow: "rtl", event_kind: "error",
      severity: "info", flag_dismissed: 0,
      extracted: { summary: "rtl event", tags: [] },
    }));
    localStorage.setItem("rtlforge:obs:fpga:1:b", JSON.stringify({
      ts: Date.now(), workflow: "fpga", event_kind: "error",
      severity: "info", flag_dismissed: 0,
      extracted: { summary: "fpga event", tags: [] },
    }));

    const { container } = render(<ObserverTab config={{ observerEnabled: true, workflow: "rtl" }} />);
    expect(container.textContent).toMatch(/rtl event/);
    expect(container.textContent).not.toMatch(/fpga event/);
  });

  it("kind filter narrows the visible list", function() {
    localStorage.setItem("rtlforge:obs:rtl:1:a", JSON.stringify({
      ts: Date.now(), workflow: "rtl", event_kind: "error",
      severity: "info", flag_dismissed: 0,
      extracted: { summary: "an error event", tags: [] },
    }));
    localStorage.setItem("rtlforge:obs:rtl:2:b", JSON.stringify({
      ts: Date.now(), workflow: "rtl", event_kind: "fix",
      severity: "info", flag_dismissed: 0,
      extracted: { summary: "a fix event", tags: [] },
    }));

    const { container, getAllByRole } = render(<ObserverTab config={{ observerEnabled: true, workflow: "rtl" }} />);
    expect(container.textContent).toMatch(/an error event/);
    expect(container.textContent).toMatch(/a fix event/);
    // Filter by kind=error — the kind select is the first <select> in the
    // filter row. (Severity is the second.)
    const selects = getAllByRole("combobox");
    fireEvent.change(selects[0], { target: { value: "error" } });
    expect(container.textContent).toMatch(/an error event/);
    expect(container.textContent).not.toMatch(/a fix event/);
  });
});
