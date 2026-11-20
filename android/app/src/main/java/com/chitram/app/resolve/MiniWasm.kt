package com.chitram.app.resolve

/**
 * A small WebAssembly interpreter for vaplayer's decrypt module.
 *
 * Why not a library: the module (7352 B, 2026-11-20) has no imports and uses only
 * i32 integer ops, locals, globals, loads/stores and structured control flow. It is
 * a ChaCha-style keystream whose key is baked into each module, and the module
 * rotates (wasm_url carries `w=`), so a Kotlin port of one module would break on the
 * next rotation. Running the current module keeps working after a rotation.
 *
 * Supported: the integer MVP (i32 and i64), sign-extension ops, memory.copy/fill,
 * a start function. Not supported: imports, floats, tables, call_indirect, SIMD.
 * Parsing fails fast on anything else, so a module that needs more fails the
 * vaplayer resolve (and the player falls back) instead of decrypting wrongly.
 */
class WasmException(message: String) : Exception(message)

class WasmModule private constructor(
    private val types: List<FuncType>,
    private val funcTypes: IntArray,
    private val bodies: List<Body>,
    private val memMinPages: Int,
    private val memMaxPages: Int,
    private val globalInit: LongArray,
    private val exports: Map<String, Int>, // name -> function index (functions only)
    private val memoryExport: String?,
    private val data: List<Pair<Int, ByteArray>>,
    private val start: Int,
) {
    internal class FuncType(val params: Int, val results: Int)

    internal class Body(
        val locals: Int,
        val ops: IntArray,
        val imm: LongArray,
        val target: IntArray, // block/if/else -> end pc; if -> also elseAt
        val elseAt: IntArray,
        val tables: List<IntArray>,
    )

    fun instantiate(): WasmInstance {
        val inst = WasmInstance(this, memMinPages, memMaxPages, globalInit.copyOf())
        for ((off, bytes) in data) inst.write(off, bytes)
        if (start >= 0) inst.invoke(start, LongArray(0))
        return inst
    }

    internal fun exportIndex(name: String): Int = exports[name] ?: throw WasmException("no export $name")
    internal fun typeOf(func: Int): FuncType = types[funcTypes[func]]
    internal fun body(func: Int): Body = bodies[func]
    internal fun hasMemoryExport() = memoryExport != null

    companion object {
        private const val MAGIC = 0x6d736100

        fun parse(bytes: ByteArray): WasmModule {
            val r = Reader(bytes)
            if (r.u32le() != MAGIC) throw WasmException("not a wasm module")
            if (r.u32le() != 1) throw WasmException("unsupported wasm version")
            val types = ArrayList<FuncType>()
            var funcTypes = IntArray(0)
            val bodies = ArrayList<Body>()
            var memMin = 0
            var memMax = MAX_PAGES
            val globals = ArrayList<Long>()
            val exports = HashMap<String, Int>()
            var memExport: String? = null
            val data = ArrayList<Pair<Int, ByteArray>>()
            var start = -1
            while (!r.done()) {
                val id = r.u8()
                val size = r.u32()
                val end = r.pos + size
                when (id) {
                    0, 4, 9, 12 -> r.pos = end // custom, table, element, datacount: not needed
                    1 -> repeat(r.u32()) {
                        if (r.u8() != 0x60) throw WasmException("bad func type")
                        val p = r.u32(); repeat(p) { valType(r.u8()) }
                        val n = r.u32(); repeat(n) { valType(r.u8()) }
                        types += FuncType(p, n)
                    }
                    2 -> if (r.u32() > 0) throw WasmException("imports not supported") else r.pos = end
                    3 -> funcTypes = IntArray(r.u32()) { r.u32() }
                    5 -> {
                        val n = r.u32()
                        if (n > 1) throw WasmException("multiple memories")
                        if (n == 1) {
                            val flag = r.u8()
                            memMin = r.u32()
                            if (flag and 1 == 1) memMax = r.u32()
                        }
                    }
                    6 -> repeat(r.u32()) {
                        valType(r.u8()); r.u8() // type, mutability
                        globals += constExpr(r, globals)
                    }
                    7 -> repeat(r.u32()) {
                        val name = r.name()
                        val kind = r.u8()
                        val idx = r.u32()
                        if (kind == 0) exports[name] = idx
                        if (kind == 2) memExport = name
                    }
                    8 -> start = r.u32()
                    10 -> repeat(r.u32()) {
                        val bodySize = r.u32()
                        val bodyEnd = r.pos + bodySize
                        var locals = 0
                        repeat(r.u32()) { locals += r.u32(); valType(r.u8()) }
                        bodies += compile(r, bodyEnd, locals)
                        r.pos = bodyEnd
                    }
                    11 -> repeat(r.u32()) {
                        when (val flag = r.u32()) {
                            0, 2 -> {
                                if (flag == 2) r.u32()
                                val off = constExpr(r, globals).toInt()
                                val len = r.u32()
                                data += off to r.bytes(len)
                            }
                            1 -> r.pos += r.u32() // passive segment: unused by memory.init-free modules
                            else -> throw WasmException("bad data segment")
                        }
                    }
                    else -> throw WasmException("unknown section $id")
                }
                if (r.pos != end) r.pos = end
            }
            if (bodies.size != funcTypes.size) throw WasmException("function/code count mismatch")
            return WasmModule(types, funcTypes, bodies, memMin, minOf(memMax, MAX_PAGES), globals.toLongArray(), exports, memExport, data, start)
        }

        /** 16 MB is far more than a decrypt needs; a module asking for more is refused. */
        internal const val MAX_PAGES = 256

        private fun valType(t: Int) {
            if (t != 0x7F && t != 0x7E) throw WasmException("unsupported value type 0x${t.toString(16)}")
        }

        private fun constExpr(r: Reader, globals: List<Long>): Long {
            val v = when (val op = r.u8()) {
                0x41 -> r.s32().toLong()
                0x42 -> r.s64()
                0x23 -> globals[r.u32()]
                else -> throw WasmException("unsupported const expr 0x${op.toString(16)}")
            }
            if (r.u8() != 0x0B) throw WasmException("const expr not terminated")
            return v
        }

        private fun compile(r: Reader, end: Int, locals: Int): Body {
            val ops = ArrayList<Int>()
            val imm = ArrayList<Long>()
            val tables = ArrayList<IntArray>()
            fun emit(op: Int, v: Long = 0) { ops += op; imm += v }
            while (r.pos < end) {
                when (val op = r.u8()) {
                    0x02, 0x03, 0x04 -> emit(op, blockArity(r).toLong())
                    0x0C, 0x0D, 0x10, 0x20, 0x21, 0x22, 0x23, 0x24 -> emit(op, r.u32().toLong())
                    0x0E -> {
                        val n = r.u32()
                        val t = IntArray(n + 1) { r.u32() } // last entry is the default
                        tables += t
                        emit(op, (tables.size - 1).toLong())
                    }
                    in 0x28..0x35, in 0x36..0x3E -> {
                        if (op in 0x2A..0x2B || op in 0x38..0x39) throw WasmException("float memory op")
                        r.u32() // alignment hint
                        emit(op, r.u32().toLong() and 0xFFFFFFFFL)
                    }
                    0x3F, 0x40 -> { r.u8(); emit(op) }
                    0x41 -> emit(op, r.s32().toLong())
                    0x42 -> emit(op, r.s64())
                    0xFC -> {
                        when (val sub = r.u32()) {
                            10 -> { r.u8(); r.u8(); emit(0x1FC0A) }
                            11 -> { r.u8(); emit(0x1FC0B) }
                            else -> throw WasmException("unsupported 0xFC $sub")
                        }
                    }
                    0x00, 0x01, 0x05, 0x0B, 0x0F, 0x1A, 0x1B,
                    in 0x45..0x5A, in 0x67..0x8A, 0xA7, 0xAC, 0xAD, in 0xC0..0xC4 -> emit(op)
                    else -> throw WasmException("unsupported opcode 0x${op.toString(16)}")
                }
            }
            val n = ops.size
            val target = IntArray(n) { -1 }
            val elseAt = IntArray(n) { -1 }
            val open = ArrayList<Int>()
            for (pc in 0 until n) {
                when (ops[pc]) {
                    0x02, 0x03, 0x04 -> open += pc
                    0x05 -> { val o = open.last(); elseAt[o] = pc }
                    0x0B -> if (open.isNotEmpty()) {
                        val o = open.removeAt(open.size - 1)
                        target[o] = pc
                        if (elseAt[o] >= 0) target[elseAt[o]] = pc
                    }
                }
            }
            if (open.isNotEmpty()) throw WasmException("unbalanced blocks")
            return Body(locals, ops.toIntArray(), imm.toLongArray(), target, elseAt, tables)
        }

        private fun blockArity(r: Reader): Int {
            val b = r.peek()
            if (b == 0x40) { r.u8(); return 0 }
            if (b == 0x7F || b == 0x7E) { r.u8(); return 1 }
            if (b == 0x7D || b == 0x7C) throw WasmException("float block type")
            r.s64() // type index (multi-value): only result-less param-less ones appear in practice
            throw WasmException("typed block not supported")
        }
    }

    internal class Reader(private val b: ByteArray) {
        var pos = 0
        fun done() = pos >= b.size
        fun peek(): Int = b[pos].toInt() and 0xFF
        fun u8(): Int = b[pos++].toInt() and 0xFF
        fun u32le(): Int { var v = 0; for (i in 0 until 4) v = v or (u8() shl (8 * i)); return v }
        fun u32(): Int {
            var result = 0L; var shift = 0
            while (true) {
                val x = u8()
                result = result or ((x and 0x7F).toLong() shl shift)
                if (x and 0x80 == 0) break
                shift += 7
                if (shift > 35) throw WasmException("bad u32")
            }
            return result.toInt()
        }
        fun s32(): Int = s64().toInt()
        fun s64(): Long {
            var result = 0L; var shift = 0; var x: Int
            do {
                x = u8()
                result = result or ((x and 0x7F).toLong() shl shift)
                shift += 7
            } while (x and 0x80 != 0 && shift < 70)
            if (shift < 64 && x and 0x40 != 0) result = result or (-1L shl shift)
            return result
        }
        fun bytes(n: Int): ByteArray { val o = b.copyOfRange(pos, pos + n); pos += n; return o }
        fun name(): String = String(bytes(u32()), Charsets.UTF_8)
    }
}

class WasmInstance internal constructor(
    private val module: WasmModule,
    minPages: Int,
    private val maxPages: Int,
    private val globals: LongArray,
) {
    private var mem = ByteArray(minPages * PAGE)
    private var fuel = FUEL
    private var depth = 0

    fun write(ptr: Int, bytes: ByteArray) {
        if (ptr < 0 || ptr.toLong() + bytes.size > mem.size) throw WasmException("write out of bounds")
        System.arraycopy(bytes, 0, mem, ptr, bytes.size)
    }

    fun read(ptr: Int, len: Int): ByteArray {
        if (ptr < 0 || len < 0 || ptr.toLong() + len > mem.size) throw WasmException("read out of bounds")
        return mem.copyOfRange(ptr, ptr + len)
    }

    /** Calls an exported function. Returns its single result, or null. */
    fun call(name: String, vararg args: Long): Long? {
        val f = module.exportIndex(name)
        val out = invoke(f, LongArray(args.size) { args[it] })
        return out.firstOrNull()
    }

    internal fun invoke(func: Int, args: LongArray): LongArray {
        val t = module.typeOf(func)
        if (args.size != t.params) throw WasmException("arity mismatch")
        if (++depth > 512) throw WasmException("call stack exhausted")
        try { return run(module.body(func), t, args) } finally { depth-- }
    }

    private fun addr(base: Long, off: Long, size: Int): Int {
        val a = (base and 0xFFFFFFFFL) + off
        if (a + size > mem.size) throw WasmException("memory access out of bounds")
        return a.toInt()
    }

    private fun ld(a: Int, n: Int): Long {
        var v = 0L
        for (i in 0 until n) v = v or ((mem[a + i].toLong() and 0xFF) shl (8 * i))
        return v
    }

    private fun st(a: Int, n: Int, v: Long) {
        for (i in 0 until n) mem[a + i] = (v ushr (8 * i)).toByte()
    }

    @Suppress("CyclomaticComplexMethod", "LongMethod")
    private fun run(b: WasmModule.Body, t: WasmModule.FuncType, args: LongArray): LongArray {
        val locals = LongArray(t.params + b.locals)
        System.arraycopy(args, 0, locals, 0, args.size)
        var st = LongArray(64)
        var sp = 0
        val lh = IntArray(256); val la = IntArray(256); val lt = IntArray(256); val ll = BooleanArray(256)
        var lsp = 0
        val ops = b.ops
        val imm = b.imm
        val n = ops.size
        // Function label: a branch to it (or return) jumps to the final `end`.
        lh[0] = 0; la[0] = t.results; lt[0] = n - 1; ll[0] = false; lsp = 1

        fun push(v: Long) { if (sp == st.size) st = st.copyOf(st.size * 2); st[sp++] = v }
        fun pushI(v: Int) = push(v.toLong())
        fun pushB(v: Boolean) = push(if (v) 1L else 0L)

        var pc = 0
        while (pc < n) {
            if (--fuel < 0) throw WasmException("fuel exhausted")
            val op = ops[pc]
            when (op) {
                0x00 -> throw WasmException("unreachable")
                0x01 -> {}
                0x02, 0x03, 0x04 -> {
                    if (lsp == lh.size) throw WasmException("blocks nested too deep")
                    val cond = if (op == 0x04) st[--sp].toInt() != 0 else true
                    lh[lsp] = sp; la[lsp] = imm[pc].toInt(); ll[lsp] = op == 0x03
                    lt[lsp] = if (op == 0x03) pc else b.target[pc]
                    lsp++
                    if (!cond) {
                        val e = b.elseAt[pc]
                        pc = if (e >= 0) e + 1 else b.target[pc]
                        continue
                    }
                }
                0x05 -> { pc = b.target[pc]; continue } // end of the taken branch: run the `end`
                0x0B -> { lsp--; }
                0x0C, 0x0D, 0x0E, 0x0F -> {
                    val depthToGo = when (op) {
                        0x0C -> imm[pc].toInt()
                        0x0D -> if (st[--sp].toInt() != 0) imm[pc].toInt() else -1
                        0x0E -> {
                            val table = b.tables[imm[pc].toInt()]
                            val i = st[--sp].toInt()
                            if (i >= 0 && i < table.size - 1) table[i] else table[table.size - 1]
                        }
                        else -> lsp - 1
                    }
                    if (depthToGo >= 0) {
                        val li = lsp - 1 - depthToGo
                        if (li < 0) throw WasmException("bad branch depth")
                        val arity = if (ll[li]) 0 else la[li]
                        val h = lh[li]
                        if (arity > 0) System.arraycopy(st, sp - arity, st, h, arity)
                        sp = h + arity
                        if (ll[li]) { lsp = li + 1; pc = lt[li] + 1 } else { lsp = li; pc = lt[li] + 1 }
                        continue
                    }
                }
                0x10 -> {
                    val f = imm[pc].toInt()
                    val ft = module.typeOf(f)
                    val a = LongArray(ft.params)
                    for (i in ft.params - 1 downTo 0) a[i] = st[--sp]
                    for (v in invoke(f, a)) push(v)
                }
                0x1A -> sp--
                0x1B -> { val c = st[--sp].toInt(); val y = st[--sp]; val x = st[--sp]; push(if (c != 0) x else y) }
                0x20 -> push(locals[imm[pc].toInt()])
                0x21 -> locals[imm[pc].toInt()] = st[--sp]
                0x22 -> locals[imm[pc].toInt()] = st[sp - 1]
                0x23 -> push(globals[imm[pc].toInt()])
                0x24 -> globals[imm[pc].toInt()] = st[--sp]
                // loads
                0x28 -> { val a = addr(st[--sp], imm[pc], 4); pushI(ld(a, 4).toInt()) }
                0x29 -> { val a = addr(st[--sp], imm[pc], 8); push(ld(a, 8)) }
                0x2C -> { val a = addr(st[--sp], imm[pc], 1); pushI(mem[a].toInt()) }
                0x2D -> { val a = addr(st[--sp], imm[pc], 1); pushI(mem[a].toInt() and 0xFF) }
                0x2E -> { val a = addr(st[--sp], imm[pc], 2); pushI(ld(a, 2).toShort().toInt()) }
                0x2F -> { val a = addr(st[--sp], imm[pc], 2); pushI(ld(a, 2).toInt() and 0xFFFF) }
                0x30 -> { val a = addr(st[--sp], imm[pc], 1); push(mem[a].toLong()) }
                0x31 -> { val a = addr(st[--sp], imm[pc], 1); push(mem[a].toLong() and 0xFF) }
                0x32 -> { val a = addr(st[--sp], imm[pc], 2); push(ld(a, 2).toShort().toLong()) }
                0x33 -> { val a = addr(st[--sp], imm[pc], 2); push(ld(a, 2) and 0xFFFF) }
                0x34 -> { val a = addr(st[--sp], imm[pc], 4); push(ld(a, 4).toInt().toLong()) }
                0x35 -> { val a = addr(st[--sp], imm[pc], 4); push(ld(a, 4) and 0xFFFFFFFFL) }
                // stores
                0x36, 0x37, 0x3A, 0x3B, 0x3C, 0x3D, 0x3E -> {
                    val v = st[--sp]
                    val size = when (op) { 0x36 -> 4; 0x37 -> 8; 0x3A, 0x3C -> 1; 0x3B, 0x3D -> 2; else -> 4 }
                    st(addr(st[--sp], imm[pc], size), size, v)
                }
                0x3F -> pushI(mem.size / PAGE)
                0x40 -> {
                    val add = st[--sp].toInt()
                    val old = mem.size / PAGE
                    if (add < 0 || old + add > maxPages) pushI(-1)
                    else { mem = mem.copyOf((old + add) * PAGE); pushI(old) }
                }
                0x41, 0x42 -> push(imm[pc])
                0x1FC0A -> { // memory.copy dst src len
                    val len = st[--sp].toInt(); val src = st[--sp].toInt(); val dst = st[--sp].toInt()
                    if (len != 0) System.arraycopy(mem, addr(src.toLong(), 0, len), mem, addr(dst.toLong(), 0, len), len)
                }
                0x1FC0B -> { // memory.fill dst val len
                    val len = st[--sp].toInt(); val v = st[--sp].toByte(); val dst = st[--sp].toInt()
                    if (len != 0) { val a = addr(dst.toLong(), 0, len); java.util.Arrays.fill(mem, a, a + len, v) }
                }
                // i32 tests and compares
                0x45 -> pushB(st[--sp].toInt() == 0)
                in 0x46..0x4F -> {
                    val y = st[--sp].toInt(); val x = st[--sp].toInt()
                    pushB(when (op) {
                        0x46 -> x == y; 0x47 -> x != y
                        0x48 -> x < y; 0x49 -> Integer.compareUnsigned(x, y) < 0
                        0x4A -> x > y; 0x4B -> Integer.compareUnsigned(x, y) > 0
                        0x4C -> x <= y; 0x4D -> Integer.compareUnsigned(x, y) <= 0
                        0x4E -> x >= y; else -> Integer.compareUnsigned(x, y) >= 0
                    })
                }
                0x50 -> pushB(st[--sp] == 0L)
                in 0x51..0x5A -> {
                    val y = st[--sp]; val x = st[--sp]
                    pushB(when (op) {
                        0x51 -> x == y; 0x52 -> x != y
                        0x53 -> x < y; 0x54 -> java.lang.Long.compareUnsigned(x, y) < 0
                        0x55 -> x > y; 0x56 -> java.lang.Long.compareUnsigned(x, y) > 0
                        0x57 -> x <= y; 0x58 -> java.lang.Long.compareUnsigned(x, y) <= 0
                        0x59 -> x >= y; else -> java.lang.Long.compareUnsigned(x, y) >= 0
                    })
                }
                // i32 arithmetic
                0x67 -> pushI(Integer.numberOfLeadingZeros(st[--sp].toInt()))
                0x68 -> pushI(Integer.numberOfTrailingZeros(st[--sp].toInt()))
                0x69 -> pushI(Integer.bitCount(st[--sp].toInt()))
                in 0x6A..0x78 -> {
                    val y = st[--sp].toInt(); val x = st[--sp].toInt()
                    pushI(when (op) {
                        0x6A -> x + y; 0x6B -> x - y; 0x6C -> x * y
                        0x6D -> { if (y == 0 || (x == Int.MIN_VALUE && y == -1)) throw WasmException("i32.div_s trap"); x / y }
                        0x6E -> { if (y == 0) throw WasmException("i32.div_u trap"); Integer.divideUnsigned(x, y) }
                        0x6F -> { if (y == 0) throw WasmException("i32.rem_s trap"); if (y == -1) 0 else x % y }
                        0x70 -> { if (y == 0) throw WasmException("i32.rem_u trap"); Integer.remainderUnsigned(x, y) }
                        0x71 -> x and y; 0x72 -> x or y; 0x73 -> x xor y
                        0x74 -> x shl y; 0x75 -> x shr y; 0x76 -> x ushr y
                        0x77 -> Integer.rotateLeft(x, y); else -> Integer.rotateRight(x, y)
                    })
                }
                // i64 arithmetic
                0x79 -> push(java.lang.Long.numberOfLeadingZeros(st[--sp]).toLong())
                0x7A -> push(java.lang.Long.numberOfTrailingZeros(st[--sp]).toLong())
                0x7B -> push(java.lang.Long.bitCount(st[--sp]).toLong())
                in 0x7C..0x8A -> {
                    val y = st[--sp]; val x = st[--sp]
                    push(when (op) {
                        0x7C -> x + y; 0x7D -> x - y; 0x7E -> x * y
                        0x7F -> { if (y == 0L || (x == Long.MIN_VALUE && y == -1L)) throw WasmException("i64.div_s trap"); x / y }
                        0x80 -> { if (y == 0L) throw WasmException("i64.div_u trap"); java.lang.Long.divideUnsigned(x, y) }
                        0x81 -> { if (y == 0L) throw WasmException("i64.rem_s trap"); if (y == -1L) 0L else x % y }
                        0x82 -> { if (y == 0L) throw WasmException("i64.rem_u trap"); java.lang.Long.remainderUnsigned(x, y) }
                        0x83 -> x and y; 0x84 -> x or y; 0x85 -> x xor y
                        0x86 -> x shl y.toInt(); 0x87 -> x shr y.toInt(); 0x88 -> x ushr y.toInt()
                        0x89 -> java.lang.Long.rotateLeft(x, y.toInt()); else -> java.lang.Long.rotateRight(x, y.toInt())
                    })
                }
                0xA7 -> pushI(st[--sp].toInt())
                0xAC -> push(st[--sp].toInt().toLong())
                0xAD -> push(st[--sp] and 0xFFFFFFFFL)
                0xC0 -> pushI(st[--sp].toInt().toByte().toInt())
                0xC1 -> pushI(st[--sp].toInt().toShort().toInt())
                0xC2 -> push(st[--sp].toByte().toLong())
                0xC3 -> push(st[--sp].toShort().toLong())
                0xC4 -> push(st[--sp].toInt().toLong())
                else -> throw WasmException("opcode 0x${op.toString(16)}")
            }
            pc++
        }
        if (sp < t.results) throw WasmException("stack underflow at return")
        return st.copyOfRange(sp - t.results, sp)
    }

    companion object {
        private const val PAGE = 65536
        /** Instruction budget per instance: a decrypt of a few KB needs well under 1M. */
        private const val FUEL = 200_000_000L
    }
}
