# vinsert.vim

`vinsert.vim` is a denops-based Neovim plugin that records audio on demand,
transcribes it via OpenAI's `gpt-4o-transcribe`, and reformats the text with
`gpt-5-mini`. Once recording finishes, the generated text is inserted into the
buffer, yanked into the unnamed register, or displayed in a scratch buffer
depending on the selected mode.

## Requirements

- Neovim 0.9+
- [denops.vim](https://github.com/vim-denops/denops.vim)
- Deno 1.39+
- `ffmpeg`
- OpenAI API key (`OPENAI_API_KEY` env var or `g:vinsert_openai_api_key`)

## Installation (lazy.nvim example)

```lua
{
  "yuki-yano/vinsert.vim",
  dependencies = { "vim-denops/denops.vim" },
  cmd = { 'VinsertToggle' },
  config = function()
    vim.g.vinsert_openai_api_key = os.getenv("OPENAI_API_KEY") or ""
    -- Adjust the capture backend per platform (see notes below)
    vim.g.vinsert_ffmpeg_args = {}
  end,
}
```

Add your preferred mappings manually, for example:

## Lua Configuration Example

If you prefer to set options explicitly in Lua:

```lua
vim.g.vinsert_openai_api_key = os.getenv("OPENAI_API_KEY") or ""
vim.g.vinsert_ffmpeg_args = {} -- leave empty to use platform defaults
vim.g.vinsert_language = "ja"
vim.g.vinsert_bias_prompt = ""
vim.g.vinsert_system_prompt = [[あなたは日本語の音声起こしアシスタントです。話者が発した語句だけをそのまま残し、余計な語尾や単語を加えずに句読点・改行だけを整えてください。]]
vim.g.vinsert_stt_model = "gpt-4o-transcribe"
vim.g.vinsert_text_request = {
  model = "gpt-5-mini",
  reasoning = { effort = "minimal" },
  text = { verbosity = "low" },
}
vim.g.vinsert_text_stream_flush_ms = 50
vim.g.vinsert_text_stream_batch_tokens = 20
vim.g.vinsert_indicator = "virt" -- virt | statusline | cmdline | none
vim.g.vinsert_indicator_highlights = {
  idle = "DiagnosticHint",
  rec = "DiagnosticError",
  stt = "DiagnosticWarn",
  gen = "DiagnosticInfo",
  error = "DiagnosticError",
}
vim.g.vinsert_always_yank = false -- set true to always copy the final text into the unnamed register
```

## Usage

- Insert mode `<C-q>` (default): toggle recording and insert the final text into
  the buffer.
- `:VinsertToggle yank`: record and store the final text in the unnamed register
  (buffer remains untouched).
- `:VinsertToggle scratch`: show the final output in a scratch buffer (filetype
  `markdown.vinsert`).
- Set `g:vinsert_always_yank = true` if you want to copy the final text to the
  unnamed register regardless of the selected mode.
- `:VinsertStatus`: print current phase and mode.
- `:VinsertStop`: finish the current recording and run transcription +
  generation (normal completion). Use `:VinsertCancel` if you need to abort.
- `:VinsertNextSegment`: finalize the current audio chunk and immediately start
  the next recording. Stack multiple prompts this way before running the LLM.
- `:VinsertCancel`: stop recording immediately without running transcription or
  generation.
- `:VinsertRetry`: re-run transcription and generation for the most recent audio
  capture when the model output needs another pass. Insert mode retries use the
  current cursor position; yank/scratch behave the same as the original run.

### Model configuration

Speech-to-text defaults to `gpt-4o-transcribe`. To switch to a different
Whisper/4o variant:

```lua
vim.g.vinsert_stt_model = "gpt-4o-mini-transcribe"
```

Text generation runs through the Responses API with the defaults
`model = "gpt-5-mini"`, `reasoning = { effort = "minimal" }`, and
`text = { verbosity = "low" }`. Override them together via:

```lua
vim.g.vinsert_text_request = {
  model = "gpt-5-mini",
  reasoning = { effort = "medium" },
  text = { verbosity = "balanced" },
}
```

If you only need to swap the model name, the legacy
`vim.g.vinsert_text_model = "gpt-5.1-mini"` still works and merges into the
structured request.

If your OpenAI organisation is not verified for streaming yet, disable live
updates and fall back to a single final response with:

```lua
vim.g.vinsert_text_stream = false
```

You can switch it back to `true` (the default) once streaming access becomes
available.

### Audio capture setup

`vinsert.vim` tries to pick sensible defaults for `ffmpeg` input devices:

- macOS: `{ "-f", "avfoundation", "-i", ":0" }`
- Linux: `{ "-f", "pulse", "-i", "default" }`
- Windows: `{ "-f", "dshow", "-i", "audio=default" }`

Override them if your microphone lives on a different device, e.g.

```lua
vim.g.vinsert_ffmpeg_args = { "-f", "avfoundation", "-i", ":3" }
```

Useful commands to discover device IDs:

- macOS: `ffmpeg -f avfoundation -list_devices true -i ""`
- Linux: `pactl list short sources` or `arecord -l`
- Windows: `ffmpeg -list_devices true -f dshow -i dummy`

### Notifying on completion

`vinsert.vim` emits a custom autocmd when processing finishes:

```lua
vim.api.nvim_create_autocmd("User", {
  pattern = "VinsertComplete",
  callback = function()
    local result = vim.g.vinsert_last_completion or {}
    local body = table.concat({
      string.format("Mode: %s", result.mode or "unknown"),
      string.format("Success: %s", tostring(result.success)),
      "",
      result.final or "(no text)",
    }, "\n")
    vim.notify(body, vim.log.levels.INFO, { title = "vinsert" })
  end,
})
```

`g:vinsert_last_completion` contains `mode`, `success`, `transcript`, and
`final` fields so you can customise the notification.

### Indicator highlight customisation

Virt-text indicators inherit their colours from diagnostic highlight groups by
default. Override the table to blend in with your colourscheme:

```lua
vim.g.vinsert_indicator_highlights = {
  idle = "Comment",
  rec = "WarningMsg",
  stt = "DiagnosticWarn",
  gen = "DiagnosticInfo",
  error = "DiagnosticError",
}
```

Missing keys fall back to the default palette, so you only need to override the
entries you want to change.

### Prompt customisation

The default system prompt keeps wording as-is while adding punctuation and line
breaks. Override it if you need a different tone:

```lua
vim.g.vinsert_system_prompt = [[Please rewrite the transcript as bullet points in English.]]
```

You can also describe each segment with a label and transformer pair via
`vim.g.vinsert_prompt_segments`. The first table entry applies to the first
recording chunk, the second entry to the next chunk, etc.

```lua
vim.g.vinsert_prompt_segments = {
  {
    label = "REC: Content",
    transformer = function(text)
      return ("CONTENT:\n\n%s"):format(text)
    end,
  },
  {
    label = "REC: Instructions",
    transformer = function(text)
      return ("INSTRUCTIONS:\n\n%s"):format(text)
    end,
  },
}
```

Labels are optional: when omitted, the indicator shows `REC` / `REC (n)` as
before. Transformers are optional too—omitting them falls back to the original
transcript for that segment.

### Debug logging

Enable verbose logging when you need to inspect ffmpeg commands or phase
transitions:

```lua
vim.g.vinsert_debug = true
```

Leave it unset or `false` for quiet operation.

### Statusline integration

`vinsert#status()` exposes the current mode, phase, and indicator label so
statusline plugins can consume it. For example, with lualine:

```lua
require("lualine").setup({
  sections = {
    lualine_x = {
      function()
        return vim.fn["vinsert#statusline"]()
      end,
    },
  },
})
```

If you need more control, call `vim.fn["vinsert#status"]()` instead and inspect
the returned table.

## Deno Tasks

`deno.json` defines helper tasks:

```bash
deno task cache      # pre-fetch dependencies and refresh deno.lock
deno task format     # run deno fmt
deno task lint       # run deno lint
deno task typecheck  # run deno check over core entry points
deno task test       # run unit tests
deno task ci         # run format --check, lint, typecheck, and tests sequentially
```

## Testing

```bash
deno task test
```

The test suite covers configuration normalization, scratch buffer helpers, and
indicator formatting.

## Notes

- During recording (`rec`), transcription (`stt`), generation (`gen`), and error
  states, a virt-text indicator appears by default. Errors reset the indicator
  and print a message detailing the issue (see the configuration sections above
  for highlight tweaks and statusline integration).
