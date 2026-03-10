# beam-protocol-cli

CLI for the Beam Protocol — manage identities, register agents, send intents.

## Install
```bash
npm install -g beam-protocol-cli
```

## Commands
```bash
beam init --agent my-agent --org myorg    # Generate identity
beam register                              # Register with directory
beam lookup agent@org.beam.directory       # Look up an agent
beam send agent@org.beam.directory intent  # Send an intent
beam status                                # Check directory status
```

## License
AGPL-3.0-or-later
