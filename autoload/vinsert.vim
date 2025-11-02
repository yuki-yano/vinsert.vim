function! vinsert#status() abort
  if !exists('*denops#request')
    return {
          \ 'phase': 'idle',
          \ 'mode': 'insert',
          \ 'indicatorPhase': 'idle',
          \ 'label': '',
          \ 'active': v:false,
          \ 'error': v:false,
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
          \ }
  endtry
endfunction

function! vinsert#statusline() abort
  let l:status = vinsert#status()
  return get(l:status, 'label', '')
endfunction
