# ADR-0025: Agent portraits generated with an OpenAI image model

- **Status:** Accepted
- **Date:** 2026-10-25

## Decision

- The admin console generates one head image per agent in four moods: **neutral, happy, fearful, in doubt**.
  - It uses the OpenAI Images *edit* endpoint.
  - Generation is guided by a shared **reference image** (`assets/agent-reference.png`), which can be replaced in the console.
- Model and output:
  - Model `gpt-image-2.5-flare` (`AVATAR_IMAGE_MODEL`); there is no plain `gpt-image-2.5`.
  - 1024×1024, transparent PNG, quality `medium`.
  - The *neutral* image is generated from the reference first. The other moods are edits of the neutral image, which
    keeps the character consistent.
  - The admin writes the character prompt, stored in `AgentSpec.avatarPrompt`.
- `OPENAI_API_KEY` comes from the developer's environment and is passed through compose; it is never written to `.env`.
  Without it, the feature is disabled and the console shows a hint.
- Images live on the control-plane volume (`/data/avatars/<agent>/<mood>.png`).
  - Agents fetch them through an internal endpoint (per-agent token) and serve `/api/avatar/:mood` to their UI.
  - Moods follow state:

    | State | Mood |
    |---|---|
    | completed | happy |
    | failed, expired, kill switch | fearful |
    | awaiting approval, fixing, suspended | in doubt |

## Azure

- The model runs as an Azure OpenAI image deployment, or the OpenAI API is called through APIM; the key comes from Key Vault.
- Images are stored on the control plane's Azure Files share or in Blob Storage.
