export function stripShebangPlugin() {
	return {
		name: "strip-shebang",
		transform(code, _id) {
			if (!code.startsWith("#!")) return null;
			const eol = code.indexOf("\n");
			if (eol === -1) return { code: "", map: null };
			const lineEnd = code[eol - 1] === "\r" ? eol - 1 : eol;
			return { code: code.slice(lineEnd).replace(/^\r\n/, "\n"), map: null };
		},
	};
}
