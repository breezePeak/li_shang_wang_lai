export function isDryRun(options) {
  return options.dryRun === true && options.execute !== true;
}

export function isExecute(options) {
  return options.execute === true;
}
