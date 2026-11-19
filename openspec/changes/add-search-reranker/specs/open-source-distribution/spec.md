## ADDED Requirements

### Requirement: The Docker image MUST bundle the reranker model

The published image SHALL contain the pinned ONNX artifacts and tokenizer of the reranker model (`hindsight-ai/hs-rerank-1`, pinned revision verified at build time), baked by the same build step and verified by the same mechanism as the embedding model, and the server SHALL load it with no model download at runtime. Both `linux/amd64` and `linux/arm64` builds SHALL be verified in CI to load the model and score one pair.

#### Scenario: Container reranks with no network access

- **WHEN** the container runs in an air-gapped network and an eligible `memory.search` triggers the first rerank
- **THEN** the reranker SHALL load from image-local files and score its pairs with no outbound request

#### Scenario: Build fails on a reranker artifact mismatch

- **WHEN** the build-time reranker download does not match the pinned revision
- **THEN** the image build SHALL fail, with no fallback to another model or to an image without it

## MODIFIED Requirements

### Requirement: The README MUST document hardware requirements with their rationale

The README SHALL state the memory floor and SHALL explain why: the server embeds its semantic engine in-process, an embedding model and a reranker, in exchange for requiring no external services, API keys, or network calls. The stated figures SHALL be the ones measured on the built image under a recorded workload, not estimates, and SHALL cover both models running. The README SHALL state that both models are part of the engine and always on. The model class is pinned (at most two models, ≤350M parameters in total, and a total process resident memory under a recorded workload of at most 2.5 GB); exceeding it is a breaking architectural change, not a tuning decision.

#### Scenario: A new operator evaluates rembric

- **WHEN** the README's hardware requirements section is read
- **THEN** it SHALL state the recommendation, the measured RSS basis, that both models are always on, and the zero-external-dependencies trade-off that justifies them
