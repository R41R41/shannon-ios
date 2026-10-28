/** A promise's live line without the part A-8 1 added (「（約束の外で使えるのは N）」), to compare with the contract's fixtures, which say the line as chapter 3 gave it. */
export const withoutOutside = (line: string): string => line.replace(/（約束の外で使えるのは [^）]*）/gu, '');
