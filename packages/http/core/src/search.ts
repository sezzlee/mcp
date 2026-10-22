export interface SearchDocument {
  readonly name: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly searchTerms?: readonly string[];
  readonly route: string;
  readonly alternateRoutes?: readonly string[];
  readonly parameters?: readonly string[];
}

export const nameWeight = 3.0;
export const descriptionWeight = 1.5;
export const searchTermWeight = 1.5;
export const tagWeight = 1.0;
export const routeWeight = 1.0;
export const parameterWeight = 1.0;
export const prefixMinimumLength = 3;

const k1 = 1.2;
const b = 0.75;

const letterOrDigit = /[\p{L}\p{N}]/u;
const nonSpacingMark = /\p{Mn}/gu;
/**
 * Guard: Greek writes one uppercase sigma and two lowercase ones, medial `σ` and final `ς`, so
 * lowercasing `Σ` is a context-dependent choice. JavaScript's `toLowerCase` applies Unicode's
 * conditional Final_Sigma rule, so `ΟΔΟΣ` is indexed as `οδος` while a query typed with a medial
 * sigma reads `οδοσ`. NFD cannot reconcile them the way it reconciles the
 * dotted `İ`: neither sigma decomposes. Unicode's own case folding settles the direction
 * (CaseFolding.txt `03C2; C; 03C3`).
 */
const finalSigma = /\u03C2/gu;
const upper = /\p{Lu}/u;
const lower = /\p{Ll}/u;

interface IndexedDocument {
  readonly name: string;
  readonly length: number;
}

interface MutablePostingList {
  readonly documentIds: number[];
  readonly frequencies: number[];
}

/**
 * Normalises an arbitrary string for comparison: NFD, drop `\p{Mn}`, lowercase, fold final sigma,
 * NFC. It does not tokenize, split, trim or stem; a multi-word tag folds whole, spaces included.
 */
export function foldToken(text: string): string {
  return text
    .normalize("NFD")
    .replace(nonSpacingMark, "")
    .toLowerCase()
    .replace(finalSigma, "\u03C3")
    .normalize("NFC");
}

function flush(tokens: string[], current: string): void {
  const folded = foldToken(current);
  if (folded.length < 2) {
    return;
  }
  const token =
    folded.length > 3 && folded.endsWith("s") ? folded.slice(0, -1) : folded;
  tokens.push(token);
}

export function tokenize(text: string | undefined): string[] {
  if (text === undefined || text.trim() === "") {
    return [];
  }
  const tokens: string[] = [];
  let current = "";
  for (let index = 0; index < text.length; index++) {
    const character = text[index] as string;
    if (!letterOrDigit.test(character)) {
      flush(tokens, current);
      current = "";
      continue;
    }
    const previous = index > 0 ? (text[index - 1] as string) : "";
    const next = index + 1 < text.length ? (text[index + 1] as string) : "";
    const boundary =
      previous !== "" &&
      upper.test(character) &&
      (lower.test(previous) ||
        (upper.test(previous) && next !== "" && lower.test(next)));
    if (boundary) {
      flush(tokens, current);
      current = "";
    }
    current += character;
  }
  flush(tokens, current);
  return tokens;
}

function accumulate(
  terms: Map<string, number>,
  text: string | undefined,
  weight: number,
): void {
  for (const token of tokenize(text)) {
    terms.set(token, (terms.get(token) ?? 0) + weight);
  }
}

const ordinal = (a: string, bb: string): number =>
  a < bb ? -1 : a > bb ? 1 : 0;

function lowerBound(values: readonly string[], target: string): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const value = values[middle] as string;
    if (value < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function addPostingFrequencies(
  totals: Float64Array,
  touchedDocumentIds: number[],
  postingDocumentIds: Uint32Array,
  postingFrequencies: Float64Array,
  start: number,
  end: number,
): void {
  for (let index = start; index < end; index++) {
    const documentId = postingDocumentIds[index] as number;
    const frequency = postingFrequencies[index] as number;
    if (totals[documentId] === 0) {
      touchedDocumentIds.push(documentId);
    }
    totals[documentId] = (totals[documentId] as number) + frequency;
  }
}

export class ToolIndex {
  private readonly documents: IndexedDocument[] = [];
  private readonly documentIds = new Map<string, number>();
  private readonly averageLength: number;
  private readonly ordinalDocumentIds: Uint32Array;
  private readonly ordinalRanks: Uint32Array;
  private readonly postingDocumentIds: Uint32Array;
  private readonly postingFrequencies: Float64Array;
  private readonly postingOffsets: Uint32Array;
  private readonly vocabulary: readonly string[];
  private readonly tagVocabulary: readonly string[];
  private readonly documentTagIds: Uint32Array;
  private readonly documentTagOffsets: Uint32Array;

  constructor(documents: Iterable<SearchDocument>) {
    const mutablePostings = new Map<string, MutablePostingList>();
    const documentTags: string[][] = [];
    const allTags = new Set<string>();
    for (const document of documents) {
      const terms = new Map<string, number>();
      accumulate(terms, document.name, nameWeight);
      accumulate(terms, document.description, descriptionWeight);
      const foldedTags: string[] = [];
      for (const tag of document.tags ?? []) {
        accumulate(terms, tag, tagWeight);
        const folded = foldToken(tag);
        if (!foldedTags.includes(folded)) {
          foldedTags.push(folded);
          allTags.add(folded);
        }
      }
      documentTags.push(foldedTags);
      for (const term of document.searchTerms ?? []) {
        accumulate(terms, term, searchTermWeight);
      }
      accumulate(terms, document.route, routeWeight);
      for (const alternate of document.alternateRoutes ?? []) {
        accumulate(terms, alternate, routeWeight);
      }
      for (const parameter of document.parameters ?? []) {
        accumulate(terms, parameter, parameterWeight);
      }
      let length = 0;
      for (const value of terms.values()) {
        length += value;
      }
      const documentId = this.documents.length;
      this.documents.push({ name: document.name, length });
      this.documentIds.set(document.name, documentId);
      for (const [term, frequency] of terms) {
        let posting = mutablePostings.get(term);
        if (posting === undefined) {
          posting = { documentIds: [], frequencies: [] };
          mutablePostings.set(term, posting);
        }
        posting.documentIds.push(documentId);
        posting.frequencies.push(frequency);
      }
    }
    this.averageLength =
      this.documents.length === 0
        ? 0
        : this.documents.reduce((sum, d) => sum + d.length, 0) /
          this.documents.length;
    const ordinalDocumentIds = this.documents.map(
      (_, documentId) => documentId,
    );
    ordinalDocumentIds.sort((left, right) =>
      ordinal(
        (this.documents[left] as IndexedDocument).name,
        (this.documents[right] as IndexedDocument).name,
      ),
    );
    this.ordinalDocumentIds = Uint32Array.from(ordinalDocumentIds);
    this.ordinalRanks = new Uint32Array(this.documents.length);
    for (const [rank, documentId] of ordinalDocumentIds.entries()) {
      this.ordinalRanks[documentId] = rank;
    }
    this.vocabulary = [...mutablePostings.keys()].sort(ordinal);
    let postingCount = 0;
    for (const term of this.vocabulary) {
      const posting = mutablePostings.get(term) as MutablePostingList;
      postingCount += posting.documentIds.length;
    }
    this.postingDocumentIds = new Uint32Array(postingCount);
    this.postingFrequencies = new Float64Array(postingCount);
    this.postingOffsets = new Uint32Array(this.vocabulary.length + 1);
    let postingIndex = 0;
    for (const [vocabularyIndex, term] of this.vocabulary.entries()) {
      this.postingOffsets[vocabularyIndex] = postingIndex;
      const posting = mutablePostings.get(term) as MutablePostingList;
      for (let index = 0; index < posting.documentIds.length; index++) {
        this.postingDocumentIds[postingIndex] = posting.documentIds[
          index
        ] as number;
        this.postingFrequencies[postingIndex] = posting.frequencies[
          index
        ] as number;
        postingIndex++;
      }
    }
    this.postingOffsets[this.vocabulary.length] = postingIndex;
    this.tagVocabulary = [...allTags].sort(ordinal);
    let tagCount = 0;
    for (const tags of documentTags) {
      tagCount += tags.length;
    }
    this.documentTagIds = new Uint32Array(tagCount);
    this.documentTagOffsets = new Uint32Array(documentTags.length + 1);
    let tagIndex = 0;
    for (const [documentId, tags] of documentTags.entries()) {
      this.documentTagOffsets[documentId] = tagIndex;
      for (const tag of tags) {
        this.documentTagIds[tagIndex] = lowerBound(this.tagVocabulary, tag);
        tagIndex++;
      }
    }
    this.documentTagOffsets[documentTags.length] = tagIndex;
  }

  private tagFilterIds(
    tags: readonly string[] | undefined,
  ): Uint32Array | undefined {
    if (tags === undefined || tags.length === 0) {
      return undefined;
    }
    const ids = new Uint32Array(tags.length);
    for (let index = 0; index < tags.length; index++) {
      const folded = foldToken(tags[index] as string);
      const vocabularyIndex = lowerBound(this.tagVocabulary, folded);
      ids[index] =
        this.tagVocabulary[vocabularyIndex] === folded
          ? vocabularyIndex
          : this.tagVocabulary.length;
    }
    return ids;
  }

  private carriesEveryTag(documentId: number, filterIds: Uint32Array): boolean {
    const start = this.documentTagOffsets[documentId] as number;
    const end = this.documentTagOffsets[documentId + 1] as number;
    for (let index = 0; index < filterIds.length; index++) {
      const wanted = filterIds[index] as number;
      let found = false;
      for (let cursor = start; cursor < end; cursor++) {
        if (this.documentTagIds[cursor] === wanted) {
          found = true;
          break;
        }
      }
      if (!found) {
        return false;
      }
    }
    return true;
  }

  get count(): number {
    return this.documents.length;
  }

  has(name: string): boolean {
    return this.documentIds.has(name);
  }

  retainTagged(
    names: readonly string[],
    tags: readonly string[] | undefined,
  ): string[] {
    const filterIds = this.tagFilterIds(tags);
    return names.filter((name) => {
      const documentId = this.documentIds.get(name);
      return (
        documentId !== undefined &&
        (filterIds === undefined || this.carriesEveryTag(documentId, filterIds))
      );
    });
  }

  search(
    query: string | undefined,
    limit: number,
    tags?: readonly string[],
  ): string[] {
    if (!(limit > 0)) {
      throw new RangeError("limit must be positive");
    }
    const filterIds = this.tagFilterIds(tags);
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) {
      const names: string[] = [];
      for (
        let index = 0;
        index < this.ordinalDocumentIds.length && names.length < limit;
        index++
      ) {
        const documentId = this.ordinalDocumentIds[index] as number;
        if (
          filterIds !== undefined &&
          !this.carriesEveryTag(documentId, filterIds)
        ) {
          continue;
        }
        names.push((this.documents[documentId] as IndexedDocument).name);
      }
      return names;
    }

    const frequencies = new Float64Array(this.documents.length);
    const scores = new Float64Array(this.documents.length);
    const scoredDocumentIds: number[] = [];
    for (const term of queryTerms) {
      const matchingDocumentIds: number[] = [];
      if (term.length < prefixMinimumLength) {
        const vocabularyIndex = lowerBound(this.vocabulary, term);
        if (this.vocabulary[vocabularyIndex] === term) {
          addPostingFrequencies(
            frequencies,
            matchingDocumentIds,
            this.postingDocumentIds,
            this.postingFrequencies,
            this.postingOffsets[vocabularyIndex] as number,
            this.postingOffsets[vocabularyIndex + 1] as number,
          );
        }
      } else {
        for (
          let index = lowerBound(this.vocabulary, term);
          index < this.vocabulary.length;
          index++
        ) {
          const candidate = this.vocabulary[index] as string;
          if (!candidate.startsWith(term)) {
            break;
          }
          addPostingFrequencies(
            frequencies,
            matchingDocumentIds,
            this.postingDocumentIds,
            this.postingFrequencies,
            this.postingOffsets[index] as number,
            this.postingOffsets[index + 1] as number,
          );
        }
      }
      /**
       * Guard: df counts the whole corpus. Narrowing the tag filter in above this line raises
       * idf for every term the removed documents carried, so a tags argument would reorder the
       * tools it did not remove. Pinned by tag-filter-preserves-document-frequency.json.
       */
      const documentFrequency = matchingDocumentIds.length;
      if (documentFrequency === 0) {
        continue;
      }
      const idf = Math.log(
        1 +
          (this.documents.length - documentFrequency + 0.5) /
            (documentFrequency + 0.5),
      );
      for (const documentId of matchingDocumentIds) {
        const tf = frequencies[documentId] as number;
        const document = this.documents[documentId] as IndexedDocument;
        const normalized =
          (tf * (k1 + 1)) /
          (tf + k1 * (1 - b + (b * document.length) / this.averageLength));
        if (scores[documentId] === 0) {
          scoredDocumentIds.push(documentId);
        }
        scores[documentId] = (scores[documentId] as number) + idf * normalized;
        frequencies[documentId] = 0;
      }
    }

    const survivors =
      filterIds === undefined
        ? scoredDocumentIds
        : scoredDocumentIds.filter((documentId) =>
            this.carriesEveryTag(documentId, filterIds),
          );

    return survivors
      .sort((left, right) => {
        const scoreDifference =
          (scores[right] as number) - (scores[left] as number);
        if (scoreDifference !== 0) {
          return scoreDifference;
        }
        return (
          (this.ordinalRanks[left] as number) -
          (this.ordinalRanks[right] as number)
        );
      })
      .slice(0, limit)
      .map(
        (documentId) => (this.documents[documentId] as IndexedDocument).name,
      );
  }
}
