// A store's file is rewritten without its older lines (NeDB is append-only until
// compacted). One that fails (a full or read-only disk) is said and nothing more:
// left as a rejection nobody holds it ended the whole service. Every compaction in server/ goes through here.
function compactQuietly(db, why = 'store') {
  try {
    return Promise.resolve(db.compactDatafileAsync()).catch((error) => { console.error(`${why}: not compacted:`, error.message); });
  } catch (error) {
    console.error(`${why}: not compacted:`, error.message);
    return Promise.resolve();
  }
}

module.exports = { compactQuietly };
