# Shared test setup: a fresh ABALONE_DIR (sessions run without folder canaries unless a test plants them), and devNode keys written straight into the node keystore
# (bypassing `abalone node keys add` validation, which tests/keys.sh covers).
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export ABALONE_DIR="$(mktemp -d)" ABALONE_NO_CANARIES=1
devkey() { # provider label key...
  node -e 'const fs=require("fs"),f=process.argv[1];fs.mkdirSync(require("path").dirname(f),{recursive:true});
    const s=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):{active:{},keys:[]};
    s.keys.push({kind:"api-key",provider:process.argv[2],label:process.argv[3],key:process.argv[4],added:new Date().toISOString()});
    s.active[process.argv[2]]??=process.argv[3]; fs.writeFileSync(f,JSON.stringify(s),{mode:0o600})' "$ABALONE_DIR/node/keys.json" "$@"
}
standing() { # answerer policies-json: the standing policies a human would make with abalone approvals --standing
  node -e 'const f=process.argv[1],fs=require("fs");fs.mkdirSync(require("path").dirname(f),{recursive:true,mode:0o700});const s=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):{};s[process.argv[2]]=JSON.parse(process.argv[3]);fs.writeFileSync(f,JSON.stringify(s),{mode:0o600})' "$ABALONE_DIR/approvals/standing.json" "$1" "$2"
}
stubcfg() { # a rehashed copy of tests/fixtures/config in $ABALONE_DIR/config; runner:claude standing for all four policies
  export ABALONE_CONFIG="$ABALONE_DIR/config"
  cp -r "$root/tests/fixtures/config" "$ABALONE_CONFIG"
  node "$root/tools/rehash-manifest.mjs" > /dev/null
  export STUB_SCRIPT="$root/tests/fixtures/scripts/hello.mjs" ABALONE_RUNNER_CLAUDE="$root/tests/fixtures/stub-claude.sh"
  mkdir -p "$root/runner-home/test"
  standing claude '["metadata_only","code_without_data","aggregate_k","free_text"]'

}
stub() { # script.mjs, then abalone args
  local s=$1; shift
  STUB_SCRIPT="$root/tests/fixtures/scripts/$s" "$root/bin/abalone" --model stub/script "$@"
}
