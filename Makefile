verify:
	tests/verify.sh

verify-offline:
	tests/verify.sh offline

verify-docs:
	python3 tools/check-docs.py
	git diff --check

.PHONY: verify verify-offline verify-docs
