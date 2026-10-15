package update

import "testing"

func TestSettingsInvariant(t *testing.T) {
	s := UpdateSettings{AutoCheck: false, AutoDownload: true}
	n := s.Normalize()
	if n.AutoDownload {
		t.Fatal("AutoDownload must be forced false when AutoCheck is false")
	}
	s2 := DefaultSettings()
	if !s2.AutoCheck || s2.AutoDownload {
		t.Fatalf("defaults: %+v", s2)
	}
	s3 := UpdateSettings{AutoCheck: true, AutoDownload: true}.Normalize()
	if !s3.AutoDownload {
		t.Fatal("AutoDownload should stay true when AutoCheck is true")
	}
}
