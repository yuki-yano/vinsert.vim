# vinsert.vim

`vinsert.vim` is a denops-based Neovim plugin that records audio on demand, transcribes it via OpenAI's `gpt-4o-transcribe`, and reformats the text with `gpt-5-mini`. Results are streamed live into the buffer, yanked into the unnamed register, or displayed in a scratch buffer depending on the selected mode.

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
  ft = { "lua", "vim" },
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
vim.g.vinsert_text_stream_flush_ms = 50
vim.g.vinsert_text_stream_batch_tokens = 20
vim.g.vinsert_indicator = "virt" -- virt | statusline | cmdline | none
```

## Usage

- Insert mode `<C-q>` (default): toggle recording and stream into the buffer.
- `:VinsertToggle yank`: record and store the final text in the unnamed register (buffer remains untouched).
- `:VinsertToggle scratch`: show streaming output in a scratch buffer (filetype `markdown.vinsert`).
- `:VinsertStatus`: print current phase and mode.
- `:VinsertStop`: abort recording if something goes wrong.

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

`g:vinsert_last_completion` contains `mode`, `success`, `transcript`, and `final` fields so you can customise the notification.

## Deno Tasks

`deno.json` defines helper tasks:

```bash
deno task cache   # pre-fetch dependencies and refresh deno.lock
deno task test    # run unit tests
```

## Testing

```bash
deno task test
```

The test suite covers configuration normalization, scratch buffer helpers, and indicator formatting.

## Notes

- Default ffmpeg arguments are selected per platform when `g:vinsert_ffmpeg_args` is empty:
  - macOS: `{ "-f", "avfoundation", "-i", ":0" }`
  - Linux: `{ "-f", "pulse", "-i", "default" }`
  - Windows: `{ "-f", "dshow", "-i", "audio=default" }`
  Override the list if your environment uses a different device name (e.g. on macOS: `vim.g.vinsert_ffmpeg_args = { '-f', 'avfoundation', '-i', ':3' }`).
- How to list audio capture devices:
  - macOS: `ffmpeg -f avfoundation -list_devices true -i ""`
  - Linux: `pactl list short sources` or `arecord -l`, then use the name with `-f pulse -i <name>`
  - Windows: `ffmpeg -list_devices true -f dshow -i dummy`
- The default system prompt tells the LLM to keep the original wording and only add punctuation/line breaks. Override `g:vinsert_system_prompt` if you need a different behaviour.
- During recording (`rec`), transcription (`stt`), generation (`gen`), and error states, a virt-text indicator appears by default. Errors reset the indicator and print a message detailing the issue.
