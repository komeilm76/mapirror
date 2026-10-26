# Short operator commands for the Docker Compose deployment and the local test suite.
# Override COMPOSE when using a wrapper, for example: make up COMPOSE='docker compose -f compose.prod.yaml'.
COMPOSE ?= docker compose

.PHONY: up down logs migrate test reset-admin

## Build and start the stack in the background.
up:
	$(COMPOSE) up -d --build

## Stop the stack; named volumes (database and cache) are kept.
down:
	$(COMPOSE) down

## Follow logs for every service, or one with: make logs SERVICE=api
logs:
	$(COMPOSE) logs -f $(SERVICE)

## Apply pending database migrations in the running API container.
migrate:
	$(COMPOSE) exec -T api bun scripts/migrate.ts

## Run the repository's Vitest suite locally.
test:
	bun run test

## Reset the admin password interactively in the running API container.
reset-admin:
	$(COMPOSE) exec api bun scripts/reset-admin-password.ts
