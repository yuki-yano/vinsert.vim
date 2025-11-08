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

function! s:prompt_segment_entry(idx) abort
  let l:list = get(g:, 'vinsert_prompt_segments', [])
  if type(l:list) != v:t_list || a:idx < 0 || a:idx >= len(l:list)
    return {}
  endif
  let l:item = l:list[a:idx]
  return type(l:item) == v:t_dict ? l:item : {}
endfunction

function! vinsert#prompt_segment_label(idx) abort
  let l:item = s:prompt_segment_entry(a:idx)
  let l:label = get(l:item, 'label', '')
  return type(l:label) == v:t_string ? l:label : ''
endfunction

function! vinsert#apply_prompt_segment_transformer(idx, text) abort
  try
    let l:item = s:prompt_segment_entry(a:idx)
    let l:Fn = get(l:item, 'transformer', v:null)
    if type(l:Fn) != v:t_func
      return a:text
    endif
    let l:result = call(l:Fn, [a:text])
    if type(l:result) != v:t_string
      throw printf('segment %d transformer returned non-string', a:idx + 1)
    endif
    return l:result
  catch /.*/
    call denops#notify('vinsert', 'log_warn', [
          \ printf('[vinsert] prompt transformer %d failed: %s', a:idx + 1, v:exception)
          \ ])
    return a:text
  endtry
endfunction
