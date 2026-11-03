# Cold-install end-to-end harness (release story 12).
# Credentials are read from YOUR environment at run time and passed into the
# container — nothing secret lives in these files or in the image.

PI_VERSION ?= 1.5.0
COMPOSE = docker compose -f docker/compose.yaml

.PHONY: e2e e2e-npm e2e-offline build shell clean

## Build the harness image (pinned Pi version).
build:
	PI_VERSION=$(PI_VERSION) $(COMPOSE) build

## Cold install from the local tarball, log in, run the live tier.
## Needs PI_MATRIX_HOMESERVER, PI_MATRIX_USERNAME, PI_MATRIX_PASSWORD set.
e2e:
	PI_VERSION=$(PI_VERSION) $(COMPOSE) build
	PI_VERSION=$(PI_VERSION) $(COMPOSE) run --rm e2e

## Same, but installed from the npm registry (proves the published artifact).
e2e-npm:
	PI_VERSION=$(PI_VERSION) $(COMPOSE) build
	SOURCE=npm PI_VERSION=$(PI_VERSION) $(COMPOSE) run --rm e2e

## Offline tier with NO network at all (proves npm test is really offline).
## Run `npm ci` on the host first: node_modules rides along into the
## container's copy, and the npm cache is mounted for deps-contract's
## install step.
e2e-offline:
	PI_VERSION=$(PI_VERSION) $(COMPOSE) build
	PI_VERSION=$(PI_VERSION) $(COMPOSE) run --rm e2e-offline

## Interactive container for the manual walkthrough.
shell:
	PI_VERSION=$(PI_VERSION) $(COMPOSE) build
	PI_VERSION=$(PI_VERSION) $(COMPOSE) run --rm --entrypoint bash e2e

clean:
	$(COMPOSE) down --rmi local --volumes --remove-orphans
