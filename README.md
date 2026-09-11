# pi-runware

Generic Runware integration for Pi.

The package registers an auth-only `runware` provider with an empty model list so Pi can store an API key through `/login runware`. It does not add chat models or slash commands.

It exposes exactly two tools:

- `runware_infer` — call any Runware task type or model with arbitrary task fields and free-form content blocks.
- `runware_models` — search, filter, and inspect models through Runware Model Search, including current official documentation pricing when Runware publishes it.

Standard tool usage and parameter information are supplied by the bundled `runware` skill.

## Install

```text
pi install git:github.com/inouemoby/pi-runware
/login runware
```

`RUNWARE_API_KEY` is also supported.
