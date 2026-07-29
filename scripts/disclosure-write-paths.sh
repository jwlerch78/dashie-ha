#!/usr/bin/env bash
# check-disclosure, part 1: every filesystem write outside /data is disclosed.
#
# SOURCED by scripts/check-disclosure.sh — it provides say/bad/warn, $ROOT and
# $fail. Not runnable on its own; run `./scripts/check-disclosure.sh writes`.
#
# This file exists separately because WRITE_SITES below is the part humans edit.
# When the gate stops you, the fix is almost always one line here plus a
# sentence in chickadee/DOCS.md — not a change to the checking logic.

# ---------------------------------------------------------------------------
# 1. Every write path outside /data is in the DOCS.md permissions table
# ---------------------------------------------------------------------------
#
# Baseline of known filesystem-write call sites in the canonical source tree.
# Fields:  file | call | count | root | docs_token
#
#   root       where this call writes, in the words a reader would use.
#   docs_token literal string that MUST appear in the DOCS.md permissions
#              section for this root to count as disclosed. EMPTY = exempt,
#              which is only legitimate for /data (add-on-private storage,
#              already covered by the table's data:rw row).
#
# `count` is how many times that call appears in that file. It is here so that
# adding a second write next to an existing one still trips the gate — the
# common shape of undisclosed drift is one more line in a file that already
# writes something.
WRITE_SITES=(
  # --- add-on server: /data (private persistent storage) -------------------
  "chickadee/server/config.js|mkdirSync|1|/data|"
  "chickadee/server/auth.js|writeFileSync|2|/data|"
  "chickadee/server/auth.js|renameSync|1|/data|"
  "chickadee/server/auth.js|unlinkSync|1|/data|"
  "chickadee/server/key-store.js|writeFileSync|1|/data/api-keys.json|"
  "chickadee/server/key-store.js|renameSync|1|/data/api-keys.json|"
  "chickadee/server/settings-store.js|writeFileSync|1|/data|"
  "chickadee/server/settings-store.js|renameSync|1|/data|"
  "chickadee/server/account-config.js|writeFileSync|1|/data|"
  "chickadee/server/account-config.js|renameSync|1|/data|"

  # --- add-on server: OUTSIDE /data (must be disclosed) --------------------
  # bridge-auth writes the master secret to /data AND provisions fallback
  # copies into the add-on config mount and the HA config dir.
  "chickadee/server/bridge-auth.js|writeFileSync|2|/data + addon_config mount + <config>/.chickadee|.chickadee/bridge_secret"
  "chickadee/server/bridge-auth.js|renameSync|2|/data + addon_config mount + <config>/.chickadee|.chickadee/bridge_secret"
  "chickadee/server/bridge-auth.js|mkdirSync|1|addon_config mount + <config>/.chickadee|addon_config"
  # the integration installer stages and swaps <config>/custom_components/chickadee
  "chickadee/server/integration-installer.js|writeFileSync|1|<config>/custom_components/chickadee|custom_components/chickadee"
  "chickadee/server/integration-installer.js|renameSync|1|<config>/custom_components/chickadee|custom_components/chickadee"
  "chickadee/server/integration-installer.js|mkdirSync|1|<config>/custom_components|custom_components/chickadee"
  # rmSync ×2 = wipe the staging dir, then DELETE the old install before the
  # swap. A delete of the user's custom_components/chickadee is the most
  # invasive thing this add-on does, so the docs must say so out loud.
  "chickadee/server/integration-installer.js|rmSync|2|<config>/custom_components/chickadee(.staging)|deletes"
  "chickadee/server/integration-installer.js|cpSync|1|<config>/custom_components/chickadee.staging|chickadee.staging"

  # --- integration (runs as HA Core, not the add-on) -----------------------
  "chickadee/integration/custom_components/chickadee/satellite_wake.py|mkdir|1|/share/microwakeword|/share/microwakeword"
  "chickadee/integration/custom_components/chickadee/satellite_wake.py|copy2|1|/share/microwakeword|/share/microwakeword"
  "chickadee/integration/custom_components/chickadee/__init__.py|makedirs|1|<config>/.chickadee|.chickadee/loaded_hash"
  "chickadee/integration/custom_components/chickadee/__init__.py|open-w|1|<config>/.chickadee/loaded_hash|.chickadee/loaded_hash"
)

JS_CALLS="writeFileSync writeFile appendFileSync appendFile createWriteStream mkdirSync mkdir renameSync unlinkSync rmSync rmdirSync copyFileSync cpSync"
PY_CALLS="write_text write_bytes makedirs mkdir copy2 copytree copyfile move rmtree"

# Emit "relpath|call" for every write call site in the canonical tree, one line
# per occurrence. Comment lines are skipped; node_modules/__pycache__ excluded.
scan_write_sites() {
  local f rel code call
  while IFS= read -r f; do
    rel="${f#$ROOT/}"
    while IFS= read -r code; do
      # strip leading whitespace, then drop comment-only lines
      code="${code#"${code%%[![:space:]]*}"}"
      case "$code" in
        //*|\#*|/\**|\**) continue ;;
      esac
      for call in $JS_CALLS; do
        case "$code" in *"$call("*) echo "$rel|$call" ;; esac
      done
    done < "$f"
  done < <(find "$ROOT/chickadee/server" -name '*.js' -not -path '*/node_modules/*' 2>/dev/null | sort)

  while IFS= read -r f; do
    rel="${f#$ROOT/}"
    while IFS= read -r code; do
      code="${code#"${code%%[![:space:]]*}"}"
      case "$code" in \#*|\**) continue ;; esac
      for call in $PY_CALLS; do
        case "$code" in *"$call("*) echo "$rel|$call" ;; esac
      done
      # open(..., "w"/"a"/"wb"/"w+") — a write; open(p, encoding=…) is not
      if echo "$code" | grep -Eq "open\(.*[\"'][wa][btx+]*[\"']"; then
        echo "$rel|open-w"
      fi
    done < "$f"
  done < <(find "$ROOT/chickadee/integration" -name '*.py' -not -path '*/__pycache__/*' 2>/dev/null | sort)
}

check_writes() {
  local perms found_file declared_file
  perms="$(awk '/^## Permissions/{f=1;next} f&&/^## /{exit} f' "$ROOT/chickadee/DOCS.md")"
  if [ -z "$perms" ]; then
    bad "could not find the '## Permissions' section in chickadee/DOCS.md"
    return
  fi

  found_file="$(mktemp)"; declared_file="$(mktemp)"
  trap 'rm -f "$found_file" "$declared_file"' RETURN

  scan_write_sites | sort | uniq -c \
    | awk '{n=$1; $1=""; sub(/^ /,""); print $0"|"n}' | sort > "$found_file"

  local entry file call count root token
  for entry in "${WRITE_SITES[@]}"; do
    IFS='|' read -r file call count root token <<< "$entry"
    echo "$file|$call|$count" >> "$declared_file"

    # A non-/data root must be named in the permissions table.
    if [ -n "$token" ]; then
      case "$perms" in
        *"$token"*) ;;
        *) bad "write to '$root' ($file → $call) is NOT disclosed:
       DOCS.md permissions section never mentions '$token'" ;;
      esac
    elif [ "${root#/data}" = "$root" ]; then
      bad "$file → $call declares root '$root' with no docs_token, but only /data may be exempt"
    fi
  done
  sort -o "$declared_file" "$declared_file"

  # New or changed write sites → someone must look at the disclosure.
  local new_sites gone_sites
  new_sites="$(comm -23 "$found_file" "$declared_file" || true)"
  gone_sites="$(comm -13 "$found_file" "$declared_file" || true)"

  if [ -n "$new_sites" ]; then
    bad "undeclared filesystem write(s) — classify, document, then add to WRITE_SITES:
$(echo "$new_sites" | sed 's/^/       /')"
  fi
  if [ -n "$gone_sites" ]; then
    bad "WRITE_SITES claims write(s) that no longer exist — stale baseline:
$(echo "$gone_sites" | sed 's/^/       /')
       (a write that went away may mean DOCS.md now over-claims; check the table too)"
  fi

  [ "$fail" -eq 0 ] && say "✅ ${#WRITE_SITES[@]} write sites accounted for; every non-/data root is in the DOCS.md permissions table"
}
