## MODIFIED Requirements

### Requirement: The Docker image MUST bundle the embedding model

The published image SHALL contain the pinned ONNX artifacts of the embedding model (`hindsight-ai/hs-embed-1`, the repository's int8 ONNX export, pinned revision verified at build time), and the server SHALL run with no model downloads at runtime (`HF_HUB_OFFLINE=1` or equivalent). Both `linux/amd64` and `linux/arm64` builds SHALL be verified in CI, including the native `onnxruntime-node` binding.

#### Scenario: Container starts with no network access to huggingface.co

- **WHEN** the container runs in an air-gapped network and a `memory.save` triggers the first embedding
- **THEN** the model SHALL load from image-local files and inference SHALL succeed with no outbound requests

#### Scenario: Build fails on artifact mismatch

- **WHEN** the build-time model download does not match the pinned revision/checksum
- **THEN** the image build SHALL fail (no silent fallback to a different model)
