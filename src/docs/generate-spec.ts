import { generateOpenApiSpec } from './openapi-generator.js'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { stringify } from 'yaml'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function main() {
  console.log('Generating OpenAPI specification...')
  
  const spec = generateOpenApiSpec()
  const yamlSpec = stringify(spec)
  
  const outputDir = path.resolve(__dirname, '../../docs')
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }
  
  const outputPath = path.join(outputDir, 'openapi.yaml')
  fs.writeFileSync(outputPath, yamlSpec, 'utf8')
  
  console.log(`OpenAPI specification generated at: ${outputPath}`)
}

main().catch((err) => {
  console.error('Failed to generate OpenAPI spec:', err)
  process.exit(1)
})
