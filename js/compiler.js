// basic stream

function InputStream(text) {
        this.pos = 0;
        this.line = 0;
        this.col = 0;
        this.text = text;
        this.len = text.length;
};

InputStream.prototype = {
        peek: function() {
                if (this.pos < this.len)
                        return this.text.charAt(this.pos);
                return null;
        },
        next: function() {
                if (this.pos < this.len) {
                        var ch = this.text.charAt(this.pos++);
                        if (ch == "\n") {
                                ++this.line;
                                this.col = 0;
                        } else {
                                ++this.col;
                        }
                        return ch;
                }
                return null;
        }
};

////////////////// basic parser
function lisp_reader(code) {
        var input = new InputStream(code);
        var list = LispCons.fromArray;
        function next() { return input.next(); };
        function peek() { return input.peek(); };
        function croak(msg) {
                throw new Error(msg
                                + " / line: " + input.line
                                + ", col: " + input.col
                                + ", pos: " + input.pos);
        };
        function read_while(pred) {
                var buf = "", ch;
                while ((ch = peek()) && pred(ch)) {
                        buf += next();
                }
                return buf;
        };
        function skip_ws() {
                read_while(function(ch){
                        switch (ch) {
                            case " ":
                            case "\n":
                            case "\t":
                            case "\x0C":
                            case "\u2028":
                            case "\u2029":
                                return true;
                        }
                });
        };
        function skip(expected) {
                if (next() != expected)
                        croak("Expecting " + expected);
        };
        function read_escaped(start, end) {
                skip(start);
                var escaped = false;
                var str = "";
                while (peek()) {
                        var ch = next();
                        if (escaped) {
                                str += ch;
                                escaped = false;
                        } else if (ch == "\\") {
                                escaped = true;
                        } else if (ch == end) {
                                break;
                        } else {
                                str += ch;
                        }
                }
                return str;
        };
        function read_string() {
                return read_escaped("\"", "\"");
        };
        function read_regexp() {
                return new LispRegexp(read_escaped("/", "/"));
        };
        function skip_comment() {
                read_while(function(ch){ return ch != "\n"; });
        };
        function read_symbol() {
                var str = read_while(function(ch){
                        if ((ch >= "a" && ch <= "z") ||
                            (ch >= "A" && ch <= "Z") ||
                            (ch >= "0" && ch <= "9"))
                                return true;
                        switch (ch) {
                            case "%": case "$": case "_": case "-":
                            case ":": case ".": case "+": case "*":
                            case "@": case "!": case "?": case "&":
                            case "=": case "<": case ">":
                            case "[": case "]":
                            case "{": case "}":
                            case "/":
                                return true;
                        }
                });
                if (str.length > 0 && /^[0-9]*\.?[0-9]*$/.test(str))
                        return parseFloat(str);
                str = str.toUpperCase();
                var m = /^(.*?)::?(.*)$/.exec(str);
                if (m) {
                        var pak = LispPackage.get(m[1] || "KEYWORD");
                        return pak.find_or_intern(m[2]);
                }
                var pak = LispPackage.get("%").intern("*PACKAGE*");
                if (pak.value) return pak.value.find_or_intern(str);
                return LispSymbol.get(str);
        };
        function read_char() {
                var ch = next() + read_while(function(ch){
                        return (ch >= "a" && ch <= "z") ||
                                (ch >= "A" && ch <= "z") ||
                                (ch >= "0" && ch <= "9") ||
                                ch == "-" || ch == "_";
                });
                if (ch.length > 1) {
                        ch = LispChar.fromName(ch);
                        if (ch == null)
                                croak("Unknown character name: " + ch);
                        return ch;
                }
                return new LispChar(ch);
        };
        function read_sharp() {
                skip("#");
                switch (peek()) {
                    case "\\": next(); return read_char();
                    case "/": return read_regexp();
                    case "(": return new LispCons(LispSymbol.get("VECTOR"), read_list());
                    default:
                        croak("Unsupported sharp syntax: #" + peek());
                }
        };
        function read_quote() {
                skip("'");
                return list([ LispSymbol.get("QUOTE"), read_token() ]);
        };
        var in_qq = 0;
        function read_quasiquote() {
                skip("`");
                skip_ws();
                if (peek() != "(")
                        return list([ LispSymbol.get("QUOTE"), read_token() ]);
                ++in_qq;
                var ret = list([ LispSymbol.get("QUASIQUOTE"), read_token() ]);
                --in_qq;
                return ret;
        };
        function read_comma() {
                if (in_qq == 0) croak("Comma outside quasiquote");
                skip(",");
                skip_ws();
                var ret;
                --in_qq;
                if (peek() == "@") {
                        next();
                        ret = list([ LispSymbol.get("QQ-SPLICE"), read_token() ]);
                }
                else ret = list([ LispSymbol.get("QQ-UNQUOTE"), read_token() ]);
                ++in_qq;
                return ret;
        };
        function read_token() {
                out: while (true) {
                        skip_ws();
                        var ch = peek();
                        switch (ch) {
                            case ";"  : skip_comment(); continue out;
                            case "\"" : return read_string();
                            case "("  : return read_list();
                            case "#"  : return read_sharp();
                            case "`"  : return read_quasiquote();
                            case ","  : return read_comma();
                            case "'"  : return read_quote();
                            case null : return false; // EOF
                        }
                        return read_symbol();
                }
        };
        function read_list() {
                var ret = null, p;
                skip("(");
                out: while (true) {
                        skip_ws();
                        switch (peek()) {
                            case ")": break out;
                            case null: break out;
                            case ".":
                                next();
                                p.cdr = read_token();
                                skip_ws();
                                break out;
                            default:
                                var tok = read_token();
                                var cell = new LispCons(tok, null);
                                if (ret) p.cdr = cell;
                                else ret = cell;
                                p = cell;
                        }
                }
                skip(")");
                return ret;
        };
        return read_token;
};

///////////////// compiler
(function(LC){

        var cons = LC.cons
        , car = LC.car
        , cdr = LC.cdr
        , cadr = LC.cadr
        , caddr = LC.caddr
        , cadddr = LC.cadddr
        , cddr = LC.cddr
        , cdddr = LC.cdddr
        , length = LC.len
        , list = LC.fromArray;

        function find_var(name, env) {
                for (var i = 0; i < env.length; ++i) {
                        var frame = env[i];
                        for (var j = 0; j < frame.length; ++j) {
                                if (frame[j] == name)
                                        return [ i, j ];
                        }
                }
        };

        var LABEL_NUM = 0;

        var S_LAMBDA  = LispSymbol.get("LAMBDA");
        var S_IF      = LispSymbol.get("IF");
        var S_PROGN   = LispSymbol.get("PROGN");
        var S_QUOTE   = LispSymbol.get("QUOTE");
        var S_SET     = LispSymbol.get("SET!");
        var S_T       = LispSymbol.get("T");
        var S_NIL     = LispSymbol.get("NIL");
        var S_NOT     = LispSymbol.get("NOT");
        var S_CC      = LispSymbol.get("C/C");
        var S_DEFMAC  = LispSymbol.get("DEFMACRO");

        var PAK_KEYWORD = LispPackage.get("KEYWORD");

        function append() {
                var ret = [];
                for (var i = 0; i < arguments.length; ++i) {
                        var el = arguments[i];
                        if (el.length > 0)
                                ret.push.apply(ret, el);
                }
                return ret;
        };

        function gen_label() {
                return new LispLabel("L" + (++LABEL_NUM));
        };

        var seq = append;

        function gen() {
                return [ slice(arguments) ];
        };

        function constantp(x) {
                switch (x) {
                    case S_T:
                    case S_NIL:
                    case true:
                    case null:
                        return true;
                }
                return typeof x == "number" || typeof x == "string" || LispRegexp.is(x) || LispChar.is(x);
        };

        function nullp(x) {
                return x === S_NIL || x == null || (x instanceof Array && x.length == 0);
        };

        function arg_count(form, min, max) {
                if (max == null) max = min;
                var len = length(cdr(form));
                if (len < min) throw new Error("Expecting at least " + min + " arguments");
                if (len > max) throw new Error("Expecting at most " + max + " arguments");
        };

        function assert(cond, error) {
                if (!cond) throw new Error(error);
        };

        function comp(x, env, VAL, MORE) {
                if (nullp(x)) return comp_const(null, VAL, MORE);
                if (LispSymbol.is(x)) {
                        switch (x) {
                            case S_NIL: return comp_const(null, VAL, MORE);
                            case S_T: return comp_const(true, VAL, MORE);
                        }
                        if (x.pak === PAK_KEYWORD)
                                return comp_const(x, VAL, MORE);
                        return comp_var(x, env, VAL, MORE);
                }
                else if (constantp(x)) {
                        return comp_const(x, VAL, MORE);
                }
                else switch (car(x)) {
                    case S_QUOTE:
                        arg_count(x, 1);
                        switch (cadr(x)) {
                            case S_NIL: return comp_const(null, VAL, MORE);
                            case S_T: return comp_const(true, VAL, MORE);
                        }
                        return comp_const(cadr(x), VAL, MORE);
                    case S_PROGN:
                        return comp_seq(cdr(x), env, VAL, MORE);
                    case S_SET:
                        arg_count(x, 2);
                        assert(LispSymbol.is(cadr(x)), "Only symbols can be set");
                        return seq(comp(caddr(x), env, true, true),
                                   gen_set(cadr(x), env),
                                   VAL ? [] : gen("POP"),
                                   MORE ? [] : gen("RET"));
                    case S_IF:
                        arg_count(x, 2, 3);
                        return comp_if(cadr(x), caddr(x), cadddr(x), env, VAL, MORE);
                    case S_CC:
                        arg_count(x, 0);
                        return VAL ? seq(gen("CC")) : [];
                    case S_DEFMAC:
                        assert(LispSymbol.is(cadr(x)), "DEFMACRO requires a symbol name for the macro");
                        return comp_defmac(cadr(x), caddr(x), cdddr(x), env, VAL, MORE);
                    case S_LAMBDA:
                        return VAL ? seq(
                                comp_lambda(cadr(x), cddr(x), env),
                                MORE ? [] : gen("RET")
                        ) : [];
                    default:
                        if (LispSymbol.is(car(x)) && car(x).macro())
                                return comp_macroexpand(car(x), cdr(x), env, VAL, MORE);
                        return comp_funcall(car(x), cdr(x), env, VAL, MORE);
                }
        };

        function comp_macroexpand(name, args, env, VAL, MORE) {
                var m = new LispMachine();
                var ast = m.call(name.macro(), args);
                var ret = comp(ast, env, VAL, MORE);
                return ret;
        };

        function comp_defmac(name, args, body, env, VAL, MORE) {
                var func = comp_lambda(args, body, env);
                func = LispMachine.assemble(func).concat(LispMachine.assemble(gen("RET")));
                func = new LispMachine().run(func);
                name.set("macro", func);
                return seq(
                        VAL ? gen("CONST", name) : "POP",
                        MORE ? [] : gen("RET")
                );
        };

        /////

        function gen_set(name, env) {
                if (!name.special()) {
                        var p = find_var(name, env);
                        if (p) return gen("LSET", p[0], p[1]);
                }
                return gen("GSET", name);
        };

        function gen_var(name, env) {
                if (!name.special()) {
                        var pos = find_var(name, env);
                        if (pos) return gen("LVAR", pos[0], pos[1]);
                }
                return gen("GVAR", name);
        };

        function comp_const(x, VAL, MORE) {
                return VAL ? seq(
                        gen("CONST", x),
                        MORE ? [] : gen("RET")
                ) : [];
        };

        function comp_var(x, env, VAL, MORE) {
                return VAL ? seq(
                        gen_var(x, env),
                        MORE ? [] : gen("RET")
                ) : [];
        };

        function comp_seq(exps, env, VAL, MORE) {
                if (nullp(exps)) return comp_const(null, VAL, MORE);
                if (nullp(cdr(exps))) return comp(car(exps), env, VAL, MORE);
                return seq(comp(car(exps), env, false, true),
                           comp_seq(cdr(exps), env, VAL, MORE));
        };

        function comp_list(exps, env) {
                if (!nullp(exps)) return seq(
                        comp(car(exps), env, true, true),
                        comp_list(cdr(exps), env)
                );
                return [];
        };

        function comp_if(pred, tthen, telse, env, VAL, MORE) {
                var pcode = comp(pred, env, true, true);
                var tcode = comp(tthen, env, VAL, MORE);
                var ecode = comp(telse, env, VAL, MORE);
                var l1 = gen_label(), l2 = gen_label();
                return seq(
                        pcode,
                        gen("FJUMP", l1),
                        tcode,
                        MORE ? gen("JUMP", l2) : [],
                        [ l1 ],
                        ecode,
                        MORE ? [ l2 ] : []
                );
        };

        function comp_funcall(f, args, env, VAL, MORE) {
                if (LispSymbol.is(f) && f.primitive() && !find_var(f, env)) {
                        // if (!VAL && !LispPrimitive.seff(f)) {
                        //         return comp_seq(args, env, false, MORE);
                        // }
                        return seq(comp_list(args, env),
                                   gen("PRIM", f, length(args)),
                                   VAL ? [] : gen("POP"),
                                   MORE ? [] : gen("RET"));
                }
                if (LC.is(f) && car(f) === S_LAMBDA && nullp(cadr(f))) {
                        assert(nullp(args), "Too many arguments");
                        return comp_seq(cddr(f), env, VAL, MORE);
                }
                if (MORE) {
                        var k = gen_label();
                        return seq(
                                gen("SAVE", k),
                                comp_list(args, env),
                                comp(f, env, true, true),
                                gen("CALL", length(args)),
                                [ k ],
                                VAL ? [] : gen("POP")
                        );
                }
                return seq(
                        comp_list(args, env),
                        comp(f, env, true, true),
                        gen("CALL", length(args))
                );
        };

        function comp_lambda(args, body, env) {
                if (LispSymbol.is(args)) {
                        return gen("FN",
                                   seq(gen("ARG_", 0),
                                       args.special() ? gen("BIND", args, 0) : [],
                                       comp_seq(body, [ [ args ] ].concat(env), true, false)));
                } else {
                        var dot = LC.isDotted(args);
                        var a = LC.toArray(args);
                        if (dot) a.push([ a.pop(), a.pop() ][0]);
                        var dyn = [];
                        for (var i = a.length; --i >= 0;) {
                                if (a[i].special())
                                        dyn.push([ "BIND", a[i], i ]);
                        }
                        if (!dot) {
                                return gen("FN",
                                           seq(gen("ARGS", a.length),
                                               dyn,
                                               comp_seq(body, [ a ].concat(env), true, false)));
                        }
                        return gen("FN",
                                   seq(gen("ARG_", dot),
                                       dyn,
                                       comp_seq(body, [ a ].concat(env), true, false)));
                }
        };

        this.lisp_compile = function(x) {
                return comp_seq(x, [], true, false);
        };

})(LispCons);
