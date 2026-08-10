const encoder = new TextEncoder()

const reportHeadingLines = new Set([
  'Research context',
  'Reviewed briefing',
  'Report boundary',
  'Sources',
  'Database coverage',
  'Recruiting trials',
  'Official U.S. treatment labels',
  'Current clinical trials',
  'Important safety points',
  'Treatment ideas to discuss',
  'Researched treatment leads',
  'AI ideas to investigate',
  'Lifestyle changes worth discussing',
  'Research institutions and study sites',
  'Researchers named in source records',
  'AI research connections',
])

const pdfSafeText = (value) => String(value || '')
  .normalize('NFKD')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[\u201c\u201d]/g, '"')
  .replace(/[\u2013\u2014]/g, '-')
  .replace(/[^\x20-\x7e\n\r\t]/g, '')

const escapePdfText = (value) => pdfSafeText(value).replace(/([\\()])/g, '\\$1')

const wrapPdfLine = (line, width = 94) => {
  const text = pdfSafeText(line).replace(/\t/g, '  ').trimEnd()
  if (!text) return ['']

  const lines = []
  let remaining = text
  while (remaining.length > width) {
    let breakAt = remaining.lastIndexOf(' ', width)
    if (breakAt < Math.floor(width * 0.45)) breakAt = width
    lines.push(remaining.slice(0, breakAt).trimEnd())
    remaining = remaining.slice(breakAt).trimStart()
  }
  lines.push(remaining)
  return lines
}

const paginatePdfLines = (lines, linesPerPage = 49) => {
  const pages = []
  for (let index = 0; index < lines.length || !pages.length; index += linesPerPage) {
    pages.push(lines.slice(index, index + linesPerPage))
  }

  // Spread a short final page over the prior page when there is a nearby blank
  // line. This keeps a long report from ending with only one stray source line.
  const finalPage = pages.at(-1)
  const priorPage = pages.at(-2)
  if (!priorPage || !finalPage || finalPage.length >= 10) return pages

  const target = Math.ceil((priorPage.length + finalPage.length) / 2)
  const nearbyBreaks = priorPage
    .map((line, index) => line === '' && index >= 10 && index < priorPage.length ? index : -1)
    .filter((index) => index >= 0)
  const splitAt = nearbyBreaks.reduce((best, index) => {
    if (best === -1 || Math.abs(index - target) < Math.abs(best - target)) return index
    return best
  }, -1)
  if (splitAt === -1) return pages

  const moved = priorPage.splice(splitAt)
  while (moved[0] === '') moved.shift()
  pages[pages.length - 1] = [...moved, ...finalPage]
  return pages
}

// This PDF is built locally so a finished report never depends on a popup,
// a print dialog, or a remote conversion service.
export const createPdfDocument = (title, text) => {
  const lines = pdfSafeText(text).replace(/\r\n/g, '\n').split('\n').flatMap((line) => wrapPdfLine(line))
  const pages = paginatePdfLines(lines)

  const fontObjectId = 3 + pages.length * 2
  const infoObjectId = fontObjectId + 1
  const pageRefs = pages.map((_, index) => `${3 + index * 2} 0 R`).join(' ')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`,
  ]

  pages.forEach((page, index) => {
    const pageObjectId = 3 + index * 2
    const contentObjectId = pageObjectId + 1
    const stream = [
      'BT',
      '/F1 10 Tf',
      '48 748 Td',
      '14 TL',
      ...page.flatMap((line) => [`(${escapePdfText(line)}) Tj`, 'T*']),
      'ET',
    ].join('\n')
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`)
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  })

  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  objects.push(`<< /Title (${escapePdfText(title)}) /Producer (researchingmycondition.com) >>`)

  let pdf = '%PDF-1.4\n%RMC\n'
  const offsets = []
  objects.forEach((object, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  offsets.forEach((offset) => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n` })
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoObjectId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  return encoder.encode(pdf)
}

const xmlSafeText = (value) => Array.from(String(value || ''))
  .filter((character) => {
    const code = character.codePointAt(0)
    return code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20
  })
  .join('')

const escapeXml = (value) => xmlSafeText(value)
  .replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&apos;',
    '"': '&quot;',
  }[character]))

const wordParagraph = (line, type = 'body') => {
  if (!line) return '<w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>'
  const text = escapeXml(type === 'bullet' ? line.replace(/^-\s+/, '') : line)
  const properties = {
    title: '<w:pStyle w:val="RmcTitle"/><w:keepNext/>',
    heading: '<w:pStyle w:val="RmcHeading"/><w:keepNext/>',
    bullet: '<w:pStyle w:val="RmcBody"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:keepLines/>',
    body: '<w:pStyle w:val="RmcBody"/>',
  }
  return `<w:p><w:pPr>${properties[type]}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
}

const wordStyles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="20"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="paragraph" w:customStyle="1" w:styleId="RmcBody"><w:name w:val="RMC Body"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:style><w:style w:type="paragraph" w:customStyle="1" w:styleId="RmcTitle"><w:name w:val="RMC Title"/><w:basedOn w:val="Normal"/><w:next w:val="RmcBody"/><w:qFormat/><w:pPr><w:spacing w:after="260"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:color w:val="087F9D"/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:customStyle="1" w:styleId="RmcHeading"><w:name w:val="RMC Heading"/><w:basedOn w:val="Normal"/><w:next w:val="RmcBody"/><w:qFormat/><w:pPr><w:spacing w:before="240" w:after="100"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:color w:val="172238"/><w:sz w:val="24"/></w:rPr></w:style></w:styles>`

const wordNumbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#x2022;"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`

const wordDocumentRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

const crc32 = (bytes) => {
  let value = 0xffffffff
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff]
  return (value ^ 0xffffffff) >>> 0
}

const concatBytes = (parts) => {
  const size = parts.reduce((total, part) => total + part.length, 0)
  const output = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

const dosTimestamp = (date) => {
  const year = Math.max(1980, Math.min(2107, date.getFullYear())) - 1980
  return {
    date: (year << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  }
}

// A small stored-ZIP writer keeps Word export dependency-free. Office Open XML
// accepts uncompressed ZIP entries, which makes the generated .docx portable.
const createStoredZip = (files) => {
  const timestamp = dosTimestamp(new Date())
  let offset = 0
  const locals = []
  const entries = []

  for (const file of files) {
    const name = encoder.encode(file.name)
    const data = typeof file.content === 'string' ? encoder.encode(file.content) : file.content
    const crc = crc32(data)
    const header = new Uint8Array(30 + name.length)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 0x0800, true)
    view.setUint16(8, 0, true)
    view.setUint16(10, timestamp.time, true)
    view.setUint16(12, timestamp.date, true)
    view.setUint32(14, crc, true)
    view.setUint32(18, data.length, true)
    view.setUint32(22, data.length, true)
    view.setUint16(26, name.length, true)
    view.setUint16(28, 0, true)
    header.set(name, 30)
    locals.push(header, data)
    entries.push({ name, crc, size: data.length, offset })
    offset += header.length + data.length
  }

  const centralParts = entries.map((entry) => {
    const header = new Uint8Array(46 + entry.name.length)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x02014b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 20, true)
    view.setUint16(8, 0x0800, true)
    view.setUint16(10, 0, true)
    view.setUint16(12, timestamp.time, true)
    view.setUint16(14, timestamp.date, true)
    view.setUint32(16, entry.crc, true)
    view.setUint32(20, entry.size, true)
    view.setUint32(24, entry.size, true)
    view.setUint16(28, entry.name.length, true)
    view.setUint16(30, 0, true)
    view.setUint16(32, 0, true)
    view.setUint16(34, 0, true)
    view.setUint16(36, 0, true)
    view.setUint32(38, 0, true)
    view.setUint32(42, entry.offset, true)
    header.set(entry.name, 46)
    return header
  })
  const central = concatBytes(centralParts)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(4, 0, true)
  endView.setUint16(6, 0, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, central.length, true)
  endView.setUint32(16, offset, true)
  endView.setUint16(20, 0, true)
  return concatBytes([...locals, central, end])
}

export const createWordDocument = (title, text) => {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  const body = lines.map((line, index) => {
    if (index === 0) return wordParagraph(line || title, 'title')
    if (reportHeadingLines.has(line)) return wordParagraph(line, 'heading')
    if (line.startsWith('- ')) return wordParagraph(line, 'bullet')
    return wordParagraph(line)
  }).join('')
  const createdAt = new Date().toISOString()
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`
  const rootRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`
  const coreProperties = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>researchingmycondition.com</dc:creator><cp:lastModifiedBy>researchingmycondition.com</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:modified></cp:coreProperties>`
  const appProperties = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>researchingmycondition.com</Application></Properties>'

  return createStoredZip([
    { name: '[Content_Types].xml', content: contentTypes },
    { name: '_rels/.rels', content: rootRelationships },
    { name: 'word/document.xml', content: documentXml },
    { name: 'word/styles.xml', content: wordStyles },
    { name: 'word/numbering.xml', content: wordNumbering },
    { name: 'word/_rels/document.xml.rels', content: wordDocumentRelationships },
    { name: 'docProps/core.xml', content: coreProperties },
    { name: 'docProps/app.xml', content: appProperties },
  ])
}

export const reportFilename = (condition, extension) => {
  const safeCondition = String(condition || 'condition').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'condition'
  return `research-report-${safeCondition}.${extension}`
}

export const downloadExport = (filename, content, type) => {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // A longer release window avoids a download race in Safari and embedded webviews.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
