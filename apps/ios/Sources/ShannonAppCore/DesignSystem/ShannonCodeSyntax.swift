// Adapted from Swift Pieces "Code Block" (registry/swift/ai/CodeBlock.swift, v2.0.0)
// by Saivion Hayes — https://github.com/Saivion/SwiftPieces
// MIT + Commons Clause License Condition v1.0. See THIRD_PARTY_NOTICES.md.
// Rewritten for Shannon: a platform-neutral lexical scanner over several
// languages, with colors resolved from Shannon semantic roles.

import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Small lexical highlighter for fenced code in replies. It is intentionally
/// shallow: keywords, type-like identifiers, strings, numbers, and comments.
/// Unknown languages are returned uncolored.
public enum ShannonCodeSyntax {
    public enum Tone: Equatable, Sendable {
        case plain
        case keyword
        case type
        case string
        case number
        case comment
    }

    public struct Token: Equatable, Sendable {
        public let text: String
        public let tone: Tone
    }

    struct Grammar {
        let keywords: Set<String>
        let lineComments: [String]
        let blockComment: (open: String, close: String)?
        let stringQuotes: Set<Character>
        let highlightsCapitalizedTypes: Bool
    }

    /// Display label for the header. Keeps the fence word but expands common aliases.
    public static func displayName(for language: String?) -> String? {
        guard let language, !language.isEmpty else { return nil }
        return aliases[language]?.label ?? language
    }

    /// Canonical grammar key for a fence word, or `nil` when it is unknown.
    public static func grammarKey(for language: String?) -> String? {
        guard let language else { return nil }
        return aliases[language]?.grammar
    }

    /// Splits code into lines of tokens. Multi-line block comments and
    /// triple-quoted strings carry their state across lines.
    public static func tokenize(_ code: String, language: String?) -> [[Token]] {
        let lines = code.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard let key = grammarKey(for: language), let grammar = grammars[key] else {
            return lines.map { [Token(text: $0, tone: .plain)] }
        }
        var state = ScanState()
        return lines.map { scan($0, grammar: grammar, state: &state) }
    }

    /// Renders one line as an AttributedString using the supplied tone colors.
    public static func attributedLine(_ tokens: [Token], color: (Tone) -> Color?) -> AttributedString {
        var result = AttributedString()
        for token in tokens {
            var run = AttributedString(token.text)
            if let value = color(token.tone) { run.foregroundColor = value }
            if token.tone == .keyword { run.inlinePresentationIntent = .stronglyEmphasized }
            result.append(run)
        }
        if result.characters.isEmpty { result = AttributedString(" ") }
        return result
    }

    struct ScanState {
        var openBlockClose: String?
        var openMultilineQuote: String?
    }

    static func scan(_ line: String, grammar: Grammar, state: inout ScanState) -> [Token] {
        let chars = Array(line)
        var tokens: [Token] = []
        var plain = ""
        var index = 0

        func flush() {
            if !plain.isEmpty { tokens.append(Token(text: plain, tone: .plain)) }
            plain = ""
        }
        func emit(_ range: Range<Int>, _ tone: Tone) {
            flush()
            tokens.append(Token(text: String(chars[range]), tone: tone))
        }
        func matches(_ marker: String, at position: Int) -> Bool {
            let marker = Array(marker)
            guard position + marker.count <= chars.count else { return false }
            return Array(chars[position..<(position + marker.count)]) == marker
        }
        func scanUntil(_ marker: String, from start: Int) -> (end: Int, closed: Bool) {
            var cursor = start
            while cursor < chars.count {
                if matches(marker, at: cursor) { return (cursor + marker.count, true) }
                cursor += 1
            }
            return (chars.count, false)
        }

        while index < chars.count {
            if let close = state.openBlockClose {
                let (end, closed) = scanUntil(close, from: index)
                emit(index..<end, .comment)
                if closed { state.openBlockClose = nil }
                index = end
                continue
            }
            if let quote = state.openMultilineQuote {
                let (end, closed) = scanUntil(quote, from: index)
                emit(index..<end, .string)
                if closed { state.openMultilineQuote = nil }
                index = end
                continue
            }
            if let marker = grammar.lineComments.first(where: { matches($0, at: index) }),
               marker != "#" || index == 0 || chars[index - 1] == " " || chars[index - 1] == "\t" {
                emit(index..<chars.count, .comment)
                index = chars.count
                continue
            }
            if let block = grammar.blockComment, matches(block.open, at: index) {
                let (end, closed) = scanUntil(block.close, from: index + block.open.count)
                emit(index..<end, .comment)
                if !closed { state.openBlockClose = block.close }
                index = end
                continue
            }
            let character = chars[index]
            if grammar.stringQuotes.contains(character) {
                let triple = String(repeating: character, count: 3)
                if character != "`", matches(triple, at: index) {
                    let (end, closed) = scanUntil(triple, from: index + 3)
                    emit(index..<end, .string)
                    if !closed { state.openMultilineQuote = triple }
                    index = end
                    continue
                }
                var cursor = index + 1
                while cursor < chars.count, chars[cursor] != character {
                    cursor += chars[cursor] == "\\" ? 2 : 1
                }
                let end = min(cursor + 1, chars.count)
                emit(index..<end, .string)
                index = end
                continue
            }
            let startsDirective = character == "#" && index + 1 < chars.count && chars[index + 1].isLetter
            if character.isLetter || character == "_" || character == "@" || character == "$" || startsDirective {
                var cursor = index + 1
                while cursor < chars.count, chars[cursor].isLetter || chars[cursor].isNumber || chars[cursor] == "_" {
                    cursor += 1
                }
                let word = String(chars[index..<cursor])
                if grammar.keywords.contains(word) || character == "@" {
                    emit(index..<cursor, .keyword)
                } else if grammar.highlightsCapitalizedTypes, character.isUppercase {
                    emit(index..<cursor, .type)
                } else {
                    plain += word
                }
                index = cursor
                continue
            }
            if character.isNumber, index == 0 || !(chars[index - 1].isLetter || chars[index - 1] == "_") {
                var cursor = index + 1
                while cursor < chars.count,
                      chars[cursor].isHexDigit || chars[cursor] == "." || chars[cursor] == "_" || chars[cursor] == "x" {
                    cursor += 1
                }
                emit(index..<cursor, .number)
                index = cursor
                continue
            }
            plain.append(character)
            index += 1
        }
        flush()
        return tokens.isEmpty ? [Token(text: "", tone: .plain)] : tokens
    }
}

// MARK: - Grammars

extension ShannonCodeSyntax {
    static let aliases: [String: (label: String, grammar: String?)] = [
        "swift": ("Swift", "swift"),
        "js": ("JavaScript", "javascript"), "javascript": ("JavaScript", "javascript"), "jsx": ("JSX", "javascript"),
        "mjs": ("JavaScript", "javascript"),
        "ts": ("TypeScript", "typescript"), "typescript": ("TypeScript", "typescript"), "tsx": ("TSX", "typescript"),
        "py": ("Python", "python"), "python": ("Python", "python"),
        "sh": ("Shell", "shell"), "bash": ("Bash", "shell"), "zsh": ("zsh", "shell"), "shell": ("Shell", "shell"),
        "console": ("Shell", "shell"),
        "json": ("JSON", "json"), "jsonc": ("JSON", "json"),
        "yaml": ("YAML", "yaml"), "yml": ("YAML", "yaml"),
        "sql": ("SQL", "sql"),
        "ruby": ("Ruby", "ruby"), "rb": ("Ruby", "ruby"),
        "go": ("Go", "go"), "rust": ("Rust", "rust"), "rs": ("Rust", "rust"),
        "kotlin": ("Kotlin", "kotlin"), "kt": ("Kotlin", "kotlin"),
        "c": ("C", "c"), "cpp": ("C++", "c"), "c++": ("C++", "c"), "objc": ("Objective-C", "c"),
        "java": ("Java", "kotlin"),
        "html": ("HTML", nil), "xml": ("XML", nil), "css": ("CSS", nil), "text": ("Text", nil),
        "txt": ("Text", nil), "plaintext": ("Text", nil), "markdown": ("Markdown", nil), "md": ("Markdown", nil),
        "diff": ("Diff", nil),
    ]

    private static let cLikeComments = (lineComments: ["//"], block: (open: "/*", close: "*/"))

    static let grammars: [String: Grammar] = [
        "swift": Grammar(
            keywords: [
                "let", "var", "func", "struct", "class", "enum", "protocol", "extension", "import", "if", "else",
                "guard", "return", "for", "in", "while", "repeat", "switch", "case", "default", "break", "continue",
                "where", "self", "Self", "true", "false", "nil", "init", "deinit", "static", "private", "fileprivate",
                "internal", "public", "open", "some", "any", "async", "await", "throws", "throw", "try", "do",
                "catch", "defer", "mutating", "override", "final", "lazy", "weak", "unowned", "is", "as", "inout",
                "typealias", "associatedtype", "subscript", "actor", "nonisolated", "super", "#if", "#else", "#endif",
            ],
            lineComments: cLikeComments.lineComments, blockComment: cLikeComments.block,
            stringQuotes: ["\""], highlightsCapitalizedTypes: true
        ),
        "javascript": Grammar(
            keywords: [
                "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case",
                "default", "break", "continue", "new", "class", "extends", "import", "export", "from", "async",
                "await", "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of", "this", "super",
                "true", "false", "null", "undefined", "yield", "static", "get", "set",
            ],
            lineComments: cLikeComments.lineComments, blockComment: cLikeComments.block,
            stringQuotes: ["\"", "'", "`"], highlightsCapitalizedTypes: true
        ),
        "typescript": Grammar(
            keywords: [
                "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case",
                "default", "break", "continue", "new", "class", "extends", "implements", "interface", "type",
                "enum", "import", "export", "from", "async", "await", "try", "catch", "finally", "throw", "typeof",
                "instanceof", "in", "of", "this", "super", "true", "false", "null", "undefined", "readonly",
                "public", "private", "protected", "as", "keyof", "satisfies", "never", "unknown", "void",
            ],
            lineComments: cLikeComments.lineComments, blockComment: cLikeComments.block,
            stringQuotes: ["\"", "'", "`"], highlightsCapitalizedTypes: true
        ),
        "python": Grammar(
            keywords: [
                "def", "class", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or", "is",
                "import", "from", "as", "with", "try", "except", "finally", "raise", "pass", "break", "continue",
                "lambda", "yield", "async", "await", "True", "False", "None", "global", "nonlocal", "self",
            ],
            lineComments: ["#"], blockComment: nil,
            stringQuotes: ["\"", "'"], highlightsCapitalizedTypes: true
        ),
        "shell": Grammar(
            keywords: [
                "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "case", "esac", "function",
                "return", "export", "local", "set", "unset", "echo", "cd", "exit",
            ],
            lineComments: ["#"], blockComment: nil,
            stringQuotes: ["\"", "'"], highlightsCapitalizedTypes: false
        ),
        "json": Grammar(
            keywords: ["true", "false", "null"],
            lineComments: [], blockComment: nil,
            stringQuotes: ["\""], highlightsCapitalizedTypes: false
        ),
        "yaml": Grammar(
            keywords: ["true", "false", "null", "yes", "no"],
            lineComments: ["#"], blockComment: nil,
            stringQuotes: ["\"", "'"], highlightsCapitalizedTypes: false
        ),
        "sql": Grammar(
            keywords: [
                "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE",
                "ALTER", "DROP", "INDEX", "JOIN", "LEFT", "INNER", "ON", "AND", "OR", "NOT", "NULL", "AS", "ORDER",
                "BY", "GROUP", "LIMIT", "PRIMARY", "KEY", "select", "from", "where", "insert", "into", "values",
                "update", "set", "delete", "create", "table", "join", "on", "and", "or", "not", "null", "as",
            ],
            lineComments: ["--"], blockComment: cLikeComments.block,
            stringQuotes: ["'"], highlightsCapitalizedTypes: false
        ),
        "ruby": Grammar(
            keywords: [
                "def", "end", "class", "module", "if", "elsif", "else", "unless", "while", "until", "do", "return",
                "yield", "begin", "rescue", "ensure", "require", "true", "false", "nil", "self", "then",
            ],
            lineComments: ["#"], blockComment: nil,
            stringQuotes: ["\"", "'"], highlightsCapitalizedTypes: true
        ),
        "go": Grammar(
            keywords: [
                "package", "import", "func", "return", "if", "else", "for", "range", "switch", "case", "default",
                "var", "const", "type", "struct", "interface", "map", "chan", "go", "defer", "select", "true",
                "false", "nil", "break", "continue",
            ],
            lineComments: cLikeComments.lineComments, blockComment: cLikeComments.block,
            stringQuotes: ["\"", "`"], highlightsCapitalizedTypes: true
        ),
        "rust": Grammar(
            keywords: [
                "fn", "let", "mut", "pub", "struct", "enum", "impl", "trait", "use", "mod", "match", "if", "else",
                "for", "in", "while", "loop", "return", "self", "Self", "true", "false", "async", "await", "move",
                "ref", "where", "crate", "const", "static",
            ],
            lineComments: cLikeComments.lineComments, blockComment: cLikeComments.block,
            stringQuotes: ["\""], highlightsCapitalizedTypes: true
        ),
        "kotlin": Grammar(
            keywords: [
                "fun", "val", "var", "class", "object", "interface", "if", "else", "when", "for", "while", "return",
                "import", "package", "public", "private", "protected", "override", "true", "false", "null", "this",
                "new", "static", "void", "final", "try", "catch", "throw",
            ],
            lineComments: cLikeComments.lineComments, blockComment: cLikeComments.block,
            stringQuotes: ["\"", "'"], highlightsCapitalizedTypes: true
        ),
        "c": Grammar(
            keywords: [
                "int", "char", "float", "double", "void", "long", "short", "unsigned", "signed", "struct", "union",
                "enum", "typedef", "const", "static", "return", "if", "else", "for", "while", "do", "switch", "case",
                "default", "break", "continue", "sizeof", "#include", "#define", "class", "public", "private",
                "namespace", "template", "auto", "nullptr", "true", "false",
            ],
            lineComments: cLikeComments.lineComments, blockComment: cLikeComments.block,
            stringQuotes: ["\"", "'"], highlightsCapitalizedTypes: true
        ),
    ]
}

// MARK: - Semantic colors

public extension Color {
    /// Syntax color resolved from Shannon semantic roles for the current appearance.
    /// Returns `nil` for plain text so it inherits the primary text color.
    static func shannonCodeSyntax(_ tone: ShannonCodeSyntax.Tone) -> Color? {
        switch tone {
        case .plain: nil
        case .keyword: shannonCodeKeyword
        case .type: shannonCodeType
        case .string: shannonCodeString
        case .number: shannonCodeNumber
        case .comment: shannonCodeComment
        }
    }

    // Keywords use Shannon's intelligence presence; types use action;
    // literals use the readable text shades of the success/attention tints.
    private static let shannonCodeKeyword = codeAdaptive(
        light: ShannonColorTokens.Intelligence.core,
        dark: ShannonColorTokens.Intelligence.sky
    )
    private static let shannonCodeType = codeAdaptive(
        light: ShannonColorTokens.Light.action,
        dark: ShannonColorTokens.Dark.action
    )
    private static let shannonCodeString = codeAdaptive(
        light: ShannonColorTokens.Light.successTintText,
        dark: ShannonColorTokens.Dark.successTintText
    )
    private static let shannonCodeNumber = codeAdaptive(
        light: ShannonColorTokens.Light.attentionTintText,
        dark: ShannonColorTokens.Dark.attentionTintText
    )
    private static let shannonCodeComment = codeAdaptive(
        light: ShannonColorTokens.Light.textSecondary,
        dark: ShannonColorTokens.Dark.textSecondary
    )

    private static func codeAdaptive(light: UInt, dark: UInt) -> Color {
#if canImport(UIKit)
        Color(UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        })
#elseif canImport(AppKit)
        Color(NSColor(name: nil) { appearance in
            let hex = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(
                calibratedRed: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        })
#else
        Color(hex: light)
#endif
    }
}
