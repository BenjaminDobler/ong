#!/usr/bin/env node
import('../dist/cli.js').catch(err => {
  console.error(err.message)
  process.exit(1)
})
