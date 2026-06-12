// Package jobs is the in-memory download job store: one goroutine per job,
// 15-minute temp-file lifecycle, and cancellation.
package jobs

import (
	"math"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/sagarjethi/self-hosted-video-downloader/internal/ytdlp"
)

// Status of a job. Serialized values match the existing API contract.
type Status string

const (
	StatusRunning Status = "running"
	StatusDone    Status = "done"
	StatusError   Status = "error"
)

// ttl is how long finished files stay on disk before cleanup.
const ttl = 15 * time.Minute

// View is the public job representation sent to the client (no server paths).
// JSON field names match the existing API contract consumed by the React UI.
type View struct {
	ID        string `json:"id"`
	Status    Status `json:"status"`
	Percent   int    `json:"percent"`
	Speed     string `json:"speed"`
	Eta       string `json:"eta"`
	FileName  string `json:"fileName,omitzero"`
	SizeBytes int64  `json:"sizeBytes,omitzero"`
	Error     string `json:"error,omitzero"`
}

type job struct {
	id        string
	status    Status
	percent   float64
	speed     string
	eta       string
	fileName  string
	filePath  string
	sizeBytes int64
	err       string
	cancelled bool
	run       *ytdlp.Run
}

// Store holds all jobs. Safe for concurrent use.
type Store struct {
	mu      sync.RWMutex
	jobs    map[string]*job
	counter int64
}

func NewStore() *Store {
	return &Store{jobs: make(map[string]*job)}
}

func (s *Store) newID() string {
	s.counter++
	return strconv.FormatInt(time.Now().UnixMilli(), 36) + "-" + strconv.FormatInt(s.counter, 10)
}

func (s *Store) view(j *job) View {
	return View{
		ID:        j.id,
		Status:    j.status,
		Percent:   int(math.Round(j.percent)),
		Speed:     j.speed,
		Eta:       j.eta,
		FileName:  j.fileName,
		SizeBytes: j.sizeBytes,
		Error:     j.err,
	}
}

// Get returns the public view of a job.
func (s *Store) Get(id string) (View, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	j, ok := s.jobs[id]
	if !ok {
		return View{}, false
	}
	return s.view(j), true
}

// FilePath returns the path and name of a finished job's file.
func (s *Store) FilePath(id string) (path, name string, ok bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	j, exists := s.jobs[id]
	if !exists || j.status != StatusDone || j.filePath == "" {
		return "", "", false
	}
	return j.filePath, j.fileName, true
}

// Start spawns a download job. onSettle runs exactly once when the job
// finishes, fails, or is cancelled (used to release rate-limit slots).
// Spawn failures surface as an error-status job, matching the Node behavior.
func (s *Store) Start(url string, typ ytdlp.DownloadType, quality string, section *ytdlp.Section, onSettle func()) (View, error) {
	dir, err := os.MkdirTemp("", "downcut-")
	if err != nil {
		onSettle()
		return View{}, err
	}

	s.mu.Lock()
	j := &job{id: s.newID(), status: StatusRunning}
	s.jobs[j.id] = j
	id := j.id
	s.mu.Unlock()

	run, err := ytdlp.StartDownload(url, typ, quality, dir, section, func(p ytdlp.Progress) {
		s.mu.Lock()
		j.percent, j.speed, j.eta = p.Percent, p.Speed, p.Eta
		s.mu.Unlock()
	})
	if err != nil {
		s.mu.Lock()
		j.status = StatusError
		j.err = err.Error()
		view := s.view(j)
		s.mu.Unlock()
		_ = os.RemoveAll(dir)
		onSettle()
		return view, nil
	}

	s.mu.Lock()
	j.run = run
	view := s.view(j)
	s.mu.Unlock()

	go func() {
		defer onSettle()
		path, err := run.Wait()

		s.mu.Lock()
		defer s.mu.Unlock()
		if err != nil {
			j.status = StatusError
			if j.cancelled {
				j.err = "Cancelled."
			} else {
				j.err = err.Error()
			}
			go func() { _ = os.RemoveAll(dir) }()
			return
		}
		j.filePath = path
		j.fileName = filepath.Base(path)
		if info, statErr := os.Stat(path); statErr == nil {
			j.sizeBytes = info.Size()
		}
		j.percent = 100
		j.status = StatusDone
		s.scheduleCleanup(id, dir)
	}()

	return view, nil
}

// Cancel kills a running job. Returns false when it isn't running.
func (s *Store) Cancel(id string) bool {
	s.mu.Lock()
	j, ok := s.jobs[id]
	if !ok || j.status != StatusRunning || j.run == nil {
		s.mu.Unlock()
		return false
	}
	j.cancelled = true
	run := j.run
	s.mu.Unlock()

	run.Cancel()
	return true
}

// scheduleCleanup removes the job and its temp dir after the TTL.
// Caller must hold s.mu.
func (s *Store) scheduleCleanup(id, dir string) {
	time.AfterFunc(ttl, func() {
		s.mu.Lock()
		delete(s.jobs, id)
		s.mu.Unlock()
		_ = os.RemoveAll(dir)
	})
}
