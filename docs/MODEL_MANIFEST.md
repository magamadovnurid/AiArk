# Model manifest

`config/models.json` is a versioned catalog. Every entry describes compatibility and one immutable artifact.

```json
{
  "id": "example-3b-q4_k_m",
  "name": "Example 3B",
  "family": "Example",
  "parameterCount": "3B",
  "quantization": "Q4_K_M",
  "format": "gguf",
  "license": "license identifier or name",
  "source": "https://publisher.example/model",
  "runtime": "llama.cpp",
  "tags": ["chat"],
  "requirements": {
    "minRamGb": 4,
    "recommendedRamGb": 8,
    "minVramGb": 4,
    "accelerators": ["metal", "cuda", "rocm", "vulkan", "cpu"],
    "platforms": ["darwin", "linux", "win32"],
    "architectures": ["arm64", "x64"]
  },
  "artifact": {
    "url": "https://publisher.example/model.gguf",
    "fileName": "model.gguf",
    "sizeBytes": 2000000000,
    "sha256": "64 lowercase hex characters",
    "chunkSizeBytes": 134217728,
    "chunkSha256": ["optional hash for every ordered chunk"]
  }
}
```

`platforms`, `architectures`, `minVramGb`, and `chunkSha256` are optional. A full artifact SHA-256 is mandatory. `chunkSha256` enables targeted in-place repair; without it, AiArk preserves the suspect file and performs a complete verified replacement.

Catalog maintainers should verify URLs, hashes, file sizes, licenses, and runtime compatibility from the model publisher before accepting an entry. Changing artifact bytes requires a new checksum and should normally use a new catalog id.
