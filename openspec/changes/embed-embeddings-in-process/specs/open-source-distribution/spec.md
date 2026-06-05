# open-source-distribution — delta for embed-embeddings-in-process

## ADDED Requirements

### Requirement: The Docker image MUST bundle the embedding model

The published image SHALL contain the pinned ONNX artifacts of the embedding model (`onnx-community/gte-multilingual-base`, q8, pinned revision verified at build time), and the server SHALL run with no model downloads at runtime (`HF_HUB_OFFLINE=1` or equivalent). Both `linux/amd64` and `linux/arm64` builds SHALL be verified in CI, including the native `onnxruntime-node` binding.

#### Scenario: Container starts with no network access to huggingface.co

- **WHEN** the container runs in an air-gapped network and a `memory.save` triggers the first embedding
- **THEN** the model SHALL load from image-local files and inference SHALL succeed with no outbound requests

#### Scenario: Build fails on artifact mismatch

- **WHEN** the build-time model download does not match the pinned revision/checksum
- **THEN** the image build SHALL fail (no silent fallback to a different model)

### Requirement: The README MUST document hardware requirements with their rationale

The README SHALL state the memory floor (minimum 1 GB RAM, recommended 2 GB) and SHALL explain why: the server embeds its semantic engine in-process in exchange for requiring no external services, API keys, or network calls. The model class is pinned (≤350M params, ≤800 MB total process RSS); exceeding it is a breaking architectural change, not a tuning decision.

#### Scenario: A new operator evaluates rembric

- **WHEN** the README's hardware requirements section is read
- **THEN** it SHALL state the 1 GB minimum / 2 GB recommendation, the measured RSS basis, and the zero-external-dependencies trade-off that justifies it
