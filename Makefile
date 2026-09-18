# Install the Agent Skill (skills/tenbin) into each CLI's skills directory as a symlink, and
# build / register the MCP server (tenbin/) with Claude Code.
# The repo is the source of truth; `make unlink` removes only links that point here.
# A name that already exists as a real path or a foreign symlink is skipped, never overwritten.

REPO       := $(CURDIR)
SKILL      := tenbin
SKILL_DIR  := $(REPO)/skills/$(SKILL)
CLAUDE_DIR := $(HOME)/.claude/skills
CODEX_DIR  := $(HOME)/.agents/skills
AGY_DIR    := $(HOME)/.gemini/antigravity-cli/skills
MCP_DIR    := $(REPO)/tenbin
MCP_NAME   := tenbin
ENV_FILE   := $(HOME)/.config/tenbin/env
# Wrapper that loads the key file at start-up so the key never lands in Claude's config.
MCP_CMD    := set -a; . "$$HOME/.config/tenbin/env"; set +a; exec node $(MCP_DIR)/dist/index.js

.DEFAULT_GOAL := help

.PHONY: help test link unlink status link-claude link-codex link-agy unlink-claude unlink-codex unlink-agy \
	env-file build-mcp register-claude unregister-claude mcp-status install-claude

help:
	@echo "make link           symlink skills/$(SKILL) into claude / codex / agy"
	@echo "make link-claude    $(CLAUDE_DIR)/$(SKILL)"
	@echo "make link-codex     $(CODEX_DIR)/$(SKILL)"
	@echo "make link-agy       $(AGY_DIR)/$(SKILL)"
	@echo "make unlink[-*]     remove only links that point into this repo"
	@echo "make status         show the current state of all three"
	@echo "make test           run the skill script tests (python3, no network)"
	@echo ""
	@echo "make env-file       create $(ENV_FILE) (chmod 600) if absent; put TYPESAFE_API_KEY=... in it"
	@echo "make build-mcp      npm ci + npm run build in tenbin/"
	@echo "make register-claude   claude mcp add $(MCP_NAME) (wrapper that sources the env file)"
	@echo "make unregister-claude claude mcp remove $(MCP_NAME)"
	@echo "make mcp-status     claude mcp get $(MCP_NAME)"
	@echo "make install-claude env-file + build-mcp + register-claude + link-claude"

# $(1) = target skills directory. Creates it if its parent exists (the CLI is installed).
define do_link
set -e; d="$(1)/$(SKILL)"; \
if [ ! -d "$$(dirname "$(1)")" ]; then echo "skip    $$d — $$(dirname "$(1)") does not exist"; exit 0; fi; \
mkdir -p "$(1)"; \
if [ -L "$$d" ]; then \
  if [ "$$(readlink "$$d")" = "$(SKILL_DIR)" ]; then echo "ok      $$d (already linked)"; \
  else echo "skip    $$d — symlink to $$(readlink "$$d")"; fi; \
elif [ -e "$$d" ]; then echo "skip    $$d — real path already there"; \
else ln -s "$(SKILL_DIR)" "$$d"; echo "link    $$d -> $(SKILL_DIR)"; fi
endef

define do_unlink
d="$(1)/$(SKILL)"; \
if [ -L "$$d" ] && [ "$$(readlink "$$d")" = "$(SKILL_DIR)" ]; then rm "$$d"; echo "unlink  $$d"; \
elif [ -e "$$d" ] || [ -L "$$d" ]; then echo "keep    $$d — not this repo's link"; \
else echo "none    $$d"; fi
endef

define do_status
d="$(1)/$(SKILL)"; \
if [ -L "$$d" ]; then \
  if [ "$$(readlink "$$d")" = "$(SKILL_DIR)" ]; then echo "linked  $$d"; else echo "foreign $$d -> $$(readlink "$$d")"; fi; \
elif [ -e "$$d" ]; then echo "real    $$d"; \
else echo "absent  $$d"; fi
endef

test:
	@python3 -m unittest discover -s skills/tenbin/scripts -p '*_test.py'

env-file:
	@if [ -f "$(ENV_FILE)" ]; then echo "ok      $(ENV_FILE) exists"; \
	else mkdir -p "$$(dirname "$(ENV_FILE)")" && chmod 700 "$$(dirname "$(ENV_FILE)")" \
	  && printf '# KEY=value, one per line. Required: TYPESAFE_API_KEY. Optional: TYPESAFE_DEFAULT_MODEL, TENBIN_*\nTYPESAFE_API_KEY=\n' > "$(ENV_FILE)" \
	  && chmod 600 "$(ENV_FILE)" && echo "created $(ENV_FILE) — add your key (console.typesafe.ai/settings/keys)"; fi
	@grep -q '^TYPESAFE_API_KEY=.\+' "$(ENV_FILE)" || echo "note    TYPESAFE_API_KEY is empty; the server will start in offline mode (lint only)"

build-mcp:
	cd $(MCP_DIR) && npm ci && npm run build

# Idempotent: an existing registration is replaced. Requires the claude CLI.
register-claude:
	@command -v claude >/dev/null || { echo "ERROR   claude CLI not found"; exit 1; }
	@[ -f "$(MCP_DIR)/dist/index.js" ] || { echo "ERROR   $(MCP_DIR)/dist/index.js missing — run make build-mcp"; exit 1; }
	@claude mcp remove $(MCP_NAME) >/dev/null 2>&1 || true
	claude mcp add $(MCP_NAME) -- sh -c '$(MCP_CMD)'
	@echo "registered $(MCP_NAME); restart the Claude Code session, then ask it to call tenbin_list_models"

unregister-claude:
	claude mcp remove $(MCP_NAME)

mcp-status:
	@claude mcp get $(MCP_NAME) 2>&1 || true

install-claude: env-file build-mcp register-claude link-claude

link: link-claude link-codex link-agy
unlink: unlink-claude unlink-codex unlink-agy

link-claude: ; @$(call do_link,$(CLAUDE_DIR))
link-codex:  ; @$(call do_link,$(CODEX_DIR))
link-agy:    ; @$(call do_link,$(AGY_DIR))

unlink-claude: ; @$(call do_unlink,$(CLAUDE_DIR))
unlink-codex:  ; @$(call do_unlink,$(CODEX_DIR))
unlink-agy:    ; @$(call do_unlink,$(AGY_DIR))

status:
	@$(call do_status,$(CLAUDE_DIR))
	@$(call do_status,$(CODEX_DIR))
	@$(call do_status,$(AGY_DIR))
