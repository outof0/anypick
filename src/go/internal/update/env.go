package update

import "os"

// Env looks up process environment. Tests inject a map-backed fake.
type Env interface {
	Getenv(key string) string
}

// OSEnv reads the real process environment.
type OSEnv struct{}

func (OSEnv) Getenv(key string) string { return os.Getenv(key) }

// MapEnv is a test double.
type MapEnv map[string]string

func (e MapEnv) Getenv(key string) string { return e[key] }
