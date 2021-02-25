"use strict";

// Require Third-party Dependencies
const secString = require("sec-literal");

// Require Internal Dependencies
const helpers = require("./utils");
const constants = require("./constants");
const ASTDeps = require("./ASTDeps");
const obfuscators = require("./obfuscators");
const { runOnProbes } = require("./probes");

// CONSTANTS
const kDictionaryStrParts = [
    "abcdefghijklmnopqrstuvwxyz",
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "0123456789"
];
const kMinimumIdsCount = 5;

const kWarningsNameStr = Object.freeze({
    [constants.warnings.parsingError]: "parsing-error",
    [constants.warnings.unsafeImport]: "unsafe-import",
    [constants.warnings.unsafeRegex]: "unsafe-regex",
    [constants.warnings.unsafeStmt]: "unsafe-stmt",
    [constants.warnings.unsafeAssign]: "unsafe-assign",
    [constants.warnings.encodedLiteral]: "encoded-literal",
    [constants.warnings.shortIdentifiers]: "short-identifiers",
    [constants.warnings.suspiciousLiteral]: "suspicious-literal",
    [constants.warnings.obfuscatedCode]: "obfuscated-code"
});

class Analysis {
    hasDictionaryString = false;
    hasPrefixedIdentifiers = false;
    varkinds = { var: 0, let: 0, const: 0 };
    idtypes = { assignExpr: 0, property: 0, variableDeclarator: 0, functionDeclaration: 0 };
    counter = {
        identifiers: 0,
        doubleUnaryArray: 0,
        computedMemberExpr: 0,
        memberExpr: 0,
        deepBinaryExpr: 0,
        encodedArrayValue: 0,
        morseLiteral: 0
    };
    identifiersName = [];

    constructor() {
        this.dependencies = new ASTDeps();

        this.identifiers = new Map();
        this.globalParts = new Map();
        this.handledEncodedLiteralValues = new Map();

        this.requireIdentifiers = new Set(["require", constants.processMainModuleRequire]);
        this.warnings = [];
        this.literalScores = [];
    }

    addWarning(symbol, value, location = helpers.rootLocation()) {
        if (symbol === constants.warnings.encodedLiteral && this.handledEncodedLiteralValues.has(value)) {
            const index = this.handledEncodedLiteralValues.get(value);
            this.warnings[index].location.push(helpers.toArrayLocation(location));

            return;
        }
        const warningName = kWarningsNameStr[symbol];
        this.warnings.push(helpers.generateWarning(warningName, { value, location }));
        if (symbol === constants.warnings.encodedLiteral) {
            this.handledEncodedLiteralValues.set(value, this.warnings.length - 1);
        }
    }

    calcAvgPrefixedIdentifiers(prefix) {
        const valuesArr = Object.values(prefix).slice().sort((left, right) => left - right);
        if (valuesArr.length === 0) {
            return 0;
        }
        const nbOfPrefixedIds = valuesArr.length === 1 ? valuesArr.pop() : (valuesArr.pop() + valuesArr.pop());
        const maxIds = this.counter.identifiers - this.idtypes.property;

        return ((nbOfPrefixedIds / maxIds) * 100);
    }

    analyzeIdentifierNames() {
        this.counter.identifiers = this.identifiersName.length;
        let encoderName = null;

        if (obfuscators.jsfuck.verify(this)) {
            encoderName = "jsfuck";
        }
        else if (obfuscators.jjencode.verify(this)) {
            encoderName = "jjencode";
        }
        else if (this.counter.morseLiteral >= 36) {
            encoderName = "morse";
        }
        else {
            // TODO: also implement Dictionnary checkup
            const { prefix, oneTimeOccurence } = secString.Patterns.commonHexadecimalPrefix(
                this.identifiersName.map((value) => value.name)
            );
            const uPrefixNames = new Set(Object.keys(prefix));

            if (this.counter.identifiers > kMinimumIdsCount && uPrefixNames.size > 0) {
                this.hasPrefixedIdentifiers = this.calcAvgPrefixedIdentifiers(prefix) > 80;
            }
            // console.log(prefix);
            // console.log(oneTimeOccurence);
            // console.log(this.hasPrefixedIdentifiers);
            // console.log(this.counter.identifiers);
            // console.log(this.counter.encodedArrayValue);

            if (uPrefixNames.size === 1 && obfuscators.freejsobfuscator.verify(this, prefix)) {
                encoderName = "freejsobfuscator";
            }
            else if (obfuscators.obfuscatorio.verify(this)) {
                encoderName = "obfuscator.io";
            }
            else if ((this.counter.identifiers > (kMinimumIdsCount * 3) && this.hasPrefixedIdentifiers)
                && (oneTimeOccurence <= 3 || this.counter.encodedArrayValue > 0)) {
                encoderName = "unknown";
            }
        }

        return [encoderName !== null, encoderName];
    }

    analyzeLiteral(node, inArrayExpr = false) {
        if (typeof node.value !== "string" || secString.Utils.isSvg(node)) {
            return;
        }

        const score = secString.Utils.stringSuspicionScore(node.value);
        if (score !== 0) {
            this.literalScores.push(score);
        }

        if (!this.hasDictionaryString) {
            const isDictionaryStr = kDictionaryStrParts.every((word) => node.value.includes(word));
            if (isDictionaryStr) {
                this.hasDictionaryString = true;
            }
        }

        if (/^[.-\s]+$/g.test(node.value)) {
            this.counter.morseLiteral++;
        }

        const { hasHexadecimalSequence, hasUnicodeSequence, isBase64 } = secString.Literal.defaultAnalysis(node);
        if ((hasHexadecimalSequence || hasUnicodeSequence) && isBase64) {
            if (inArrayExpr) {
                this.counter.encodedArrayValue++;
            }
            else {
                this.addWarning(constants.warnings.encodedLiteral, node.value, node.loc);
            }
        }
    }

    getResult(isMinified) {
        const [isObfuscated, kind] = this.analyzeIdentifierNames();
        if (isObfuscated) {
            this.addWarning(constants.warnings.obfuscatedCode, kind || "unknown");
        }

        const identifiersLengthArr = this.identifiersName
            .filter((value) => value.type !== "property" && typeof value.name === "string").map((value) => value.name.length);

        const [idsLengthAvg, stringScore] = [sum(identifiersLengthArr), sum(this.literalScores)];
        if (!isMinified && identifiersLengthArr.length > 5 && idsLengthAvg <= 1.5) {
            this.addWarning(constants.warnings.shortIdentifiers, idsLengthAvg);
        }
        if (stringScore >= 3) {
            this.addWarning(constants.warnings.suspiciousLiteral, stringScore);
        }

        return { idsLengthAvg, stringScore, warnings: this.warnings };
    }

    walk(node) {
        // Detect TryStatement and CatchClause to known which dependency is required in a Try {} clause
        if (node.type === "TryStatement" && typeof node.handler !== "undefined") {
            this.dependencies.isInTryStmt = true;
        }
        else if (node.type === "CatchClause") {
            this.dependencies.isInTryStmt = false;
        }

        return runOnProbes(node, this);
    }
}

function sum(arr = []) {
    return arr.length === 0 ? 0 : (arr.reduce((prev, curr) => prev + curr, 0) / arr.length);
}

Analysis.Warnings = constants.warnings;

module.exports = Analysis;
