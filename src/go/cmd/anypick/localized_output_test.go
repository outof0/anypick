package main

import "testing"

func TestLocalizedCLIOutputLeavesJSONStable(t *testing.T) {
	t.Setenv("ANYPICK_LANG", "zh-CN")
	defer resetGlobals()()

	globals.JSON = false
	if got := localizeCLI("Dry run — plan only:"); got != "试运行 — 仅展示计划：" {
		t.Fatalf("localized human output = %q", got)
	}

	globals.JSON = true
	if got := localizeCLI(`{"kind":"anypick-backup","version":1}`); got != `{"kind":"anypick-backup","version":1}` {
		t.Fatalf("localized JSON output = %q, want the original bytes", got)
	}
}
