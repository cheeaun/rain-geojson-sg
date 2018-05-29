const spawn = require('child_process').spawn;
const child = spawn('npm', ['start'], { shell: true });
child.stdout.on('data', (data) => {
  console.log(data.toString());
});
child.stderr.on('data', (data) => {
  console.log(data.toString());
});
child.on('close', (code) => {
  console.log('closing code: ' + code);
});