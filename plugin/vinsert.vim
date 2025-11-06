if exists('g:loaded_vinsert')
  finish
endif
let g:loaded_vinsert = 1

command! -nargs=? VinsertToggle call denops#notify('vinsert', 'toggle', [<q-args>])
command! -nargs=? VinsertStart  call denops#notify('vinsert', 'start',  [<q-args>])
command!          VinsertStop   call denops#notify('vinsert', 'stop',   [])
command!          VinsertStatus call denops#notify('vinsert', 'status', [])
command!          VinsertCancel call denops#notify('vinsert', 'cancel', [])
command!          VinsertRetry  call denops#notify('vinsert', 'retry',  [])

augroup VinsertIndicatorRefresh
  autocmd!
  autocmd TextChanged,TextChangedI * call denops#notify('vinsert', 'refresh_indicator', [])
augroup END
