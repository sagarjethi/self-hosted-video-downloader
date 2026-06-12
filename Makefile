# Downcut build targets. The Go binary embeds web/dist, so the UI must be
# built first — `make build` handles the ordering.

.PHONY: build ui go run test lint clean docker

build: ui go            ## build UI then the downcut binary

ui:                     ## build the React UI into web/dist
	npm run build

go:                     ## build the Go binary (requires web/dist)
	CGO_ENABLED=0 go build -ldflags="-s -w" -o downcut ./cmd/downcut

run: build              ## build everything and run on :8787
	./downcut

test:                   ## run Go tests
	go test ./...

lint:                   ## gofmt + go vet
	@test -z "$$(gofmt -l .)" || (gofmt -l . && exit 1)
	go vet ./...

docker:                 ## build the Docker image
	docker build -t downcut .

clean:
	rm -f downcut
	rm -rf web/dist
