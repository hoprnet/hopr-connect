import yargs from 'yargs/yargs'
import { createConnection, createServer } from 'net'
import { once } from 'events'

function parseCLIArgs() {
  return yargs(process.argv.slice(2))
    .option('port', {
      describe: 'node port',
      type: 'number',
      demandOption: true
    })
    .option('badDial', {
      type: 'boolean'
    })
    .option('badAnswer', {
      type: 'boolean'
    })
    .parseSync()
}

async function main() {
  const argv = parseCLIArgs()

  if (argv.badDial) {
    const socket = createConnection(
      {
        port: argv.port
      },
      async () => {
        socket.write(Buffer.from('\x13/multistream/1.0.0\n'))
        socket.end()
      }
    )
  } else if (argv.badAnswer) {
    const server = createServer()

    server.listen(argv.port)

    await once(server, 'listening')

    server.on('connection', (socket) => {
      socket.on('data', () => {
        socket.write(Buffer.from('\x13/multistream/0.0.0\n'))
      })
    })
  }
}

main()
