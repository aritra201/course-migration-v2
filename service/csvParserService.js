const fs = require('fs');
const { parse } = require('csv-parse');

function createParserPipeline(filePath) {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const parser = stream.pipe(
        parse({
            columns: true,
            relax_column_count: true,
            relax_quotes: true,
            skip_empty_lines: true,
            bom: true,
        }),
    );
    return { stream, parser };
}

function isPresentCsvPath(filePath) {
    return typeof filePath === 'string' && filePath.length > 0 && fs.existsSync(filePath);
}

/**
 * Stream CSV rows; return false from visitor to stop reading (closes the file stream).
 * Falsy paths are skipped so optional CSVs can be omitted from config.
 */
async function streamCsvRecords(filePath, visitor) {
    if (!filePath) {
        return;
    }

    const { stream, parser } = createParserPipeline(filePath);

    try {
        await new Promise((resolve, reject) => {
            stream.once('error', reject);
            parser.once('error', reject);

            (async () => {
                try {
                    for await (const row of parser) {
                        const shouldContinue = await visitor(row);
                        if (shouldContinue === false) {
                            break;
                        }
                    }
                    resolve();
                } catch (error) {
                    reject(error);
                }
            })();
        });
    } finally {
        if (!stream.destroyed) {
            stream.destroy();
        }
    }
}

async function collectAllCsvRows(filePath) {
    if (!filePath) {
        return [];
    }

    const rows = [];
    await streamCsvRecords(filePath, (row) => {
        rows.push(row);
        return true;
    });
    return rows;
}

async function collectCsvRowsWhere(filePath, predicate) {
    if (!filePath) {
        return [];
    }

    const rows = [];
    await streamCsvRecords(filePath, (row) => {
        if (predicate(row)) {
            rows.push(row);
        }
        return true;
    });
    return rows;
}

/** Load all rows when the CSV exists; otherwise return []. */
async function collectOptionalAllCsvRows(filePath) {
    if (!isPresentCsvPath(filePath)) {
        return [];
    }

    return collectAllCsvRows(filePath);
}

/** Load matching rows when the CSV exists; otherwise return []. */
async function collectOptionalCsvRowsWhere(filePath, predicate) {
    if (!isPresentCsvPath(filePath)) {
        return [];
    }

    return collectCsvRowsWhere(filePath, predicate);
}

async function collectFirstNCsvRows(filePath, n) {
    if (n <= 0) {
        return [];
    }

    return collectCsvRowsSlice(filePath, 0, n);
}

/**
 * Read CSV rows in file order: skip `offset`, then take up to `limit` rows.
 * limit = Infinity (default) means take all rows after offset.
 */
async function collectCsvRowsSlice(filePath, offset = 0, limit = Number.POSITIVE_INFINITY) {
    const off = Math.max(0, Number(offset) || 0);
    const lim = limit == null || limit === '' ? Number.POSITIVE_INFINITY : Number(limit);

    if (lim <= 0) {
        return [];
    }

    const rows = [];
    let skipped = 0;

    await streamCsvRecords(filePath, (row) => {
        if (skipped < off) {
            skipped++;
            return true;
        }

        rows.push(row);

        if (rows.length >= lim) {
            return false;
        }

        return true;
    });

    return rows;
}

/** @deprecated Prefer collectAllCsvRows — kept for callers that still use this name. */
async function parseCsvFile(filePath) {
    return collectAllCsvRows(filePath);
}

module.exports = {
    parseCsvFile,
    collectAllCsvRows,
    collectCsvRowsWhere,
    collectOptionalAllCsvRows,
    collectOptionalCsvRowsWhere,
    collectFirstNCsvRows,
    collectCsvRowsSlice,
    streamCsvRecords,
};
