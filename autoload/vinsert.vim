function! vinsert#status() abort
  if !exists('*denops#request')
    return {
          \ 'phase': 'idle',
          \ 'mode': 'insert',
          \ 'indicatorPhase': 'idle',
          \ 'label': '',
          \ 'active': v:false,
          \ 'error': v:false,
          \ 'segmentIndex': 1,
          \ }
  endif
  try
    return denops#request('vinsert', 'status_info', [])
  catch
    return {
          \ 'phase': 'idle',
          \ 'mode': 'insert',
          \ 'indicatorPhase': 'idle',
          \ 'label': '',
          \ 'active': v:false,
          \ 'error': v:false,
          \ 'segmentIndex': 1,
          \ }
  endtry
endfunction

function! vinsert#statusline() abort
  let l:status = vinsert#status()
  return get(l:status, 'label', '')
endfunction

function! vinsert#apply_prompt_segment_transformer(idx, text) abort
  let l:list = get(g:, 'vinsert_prompt_segment_transformers', [])
  if type(l:list) != v:t_list || a:idx < 0 || a:idx >= len(l:list)
    return a:text
  endif
  let l:Fn = l:list[a:idx]
  try
    let l:result = call(l:Fn, [a:text])
    if type(l:result) != v:t_string
      call denops#notify('vinsert', 'log_warn', [
            \ printf('[vinsert] prompt transformer %d returned non-string', a:idx + 1)
            \ ])
      return a:text
    endif
    return l:result
  catch /.*/
    call denops#notify('vinsert', 'log_warn', [
          \ printf('[vinsert] prompt transformer %d failed: %s', a:idx + 1, v:exception)
          \ ])
    return a:text
  endtry
endfunction
