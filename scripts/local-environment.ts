/** Keep OS/runtime discovery without inherited model keys, proxies, Node preload flags or dev auth. */
export function localProcessEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(path|pathext|systemroot|windir|temp|tmp|tmpdir|appdata|localappdata|userprofile|home|programfiles|programfiles\(x86\))$/i.test(key)));
}
