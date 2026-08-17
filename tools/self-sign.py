#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
self-sign.py — OpenHarmony 二进制自签名实现 (Python 3, 仅用 hashlib)

用法:
    python3 self-sign.py <input_elf> [output_elf]
        缺省 output 时, inplace 改写 input.
"""
# Source: https://github.com/hqzing/ohos-bst-light (MIT) — vendored for offline use.
import hashlib
import struct
import sys

DESC_SIZE = 256
PAGE_SIZE = 4096
FLAG_SELF_SIGN = 0x10
FS_VERITY_DESCRIPTOR_TYPE = 1
HASH_OUT = 32  # SHA-256 输出字节数


def sha256(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


# ─────────────────────── ELF64 section 注入器 ───────────────────────
def inject_codesign_section(raw: bytes) -> tuple[bytes, int]:
    """自注入 .codesign 段到 ELF64 末尾, 段文件偏移 4KB 对齐, 段内容 4KB 全0占位,
    并更新 section header table + shstrtab. 与上游 binary-sign-tool 产物在段级等价.
    返回 (含段产物, 段文件偏移)."""
    # ELF64 header 字段偏移
    E_SHOFF, E_SHNUM, E_SHSTRNDX = 0x28, 0x3c, 0x3e
    if len(raw) < 64 or raw[:4] != b"\x7fELF" or raw[4] != 2:
        raise ValueError("not ELF64")
    e_shoff = struct.unpack_from("<Q", raw, E_SHOFF)[0]
    e_shnum = struct.unpack_from("<H", raw, E_SHNUM)[0]
    e_shstrndx = struct.unpack_from("<H", raw, E_SHSTRNDX)[0]
    if e_shoff == 0 or e_shnum == 0 or e_shstrndx >= e_shnum:
        raise ValueError("no section header table (stripped ELF unsupported)")

    # shstrtab entry
    shstr_e = raw[e_shoff + e_shstrndx * 64 : e_shoff + (e_shstrndx + 1) * 64]
    shstr_off = struct.unpack_from("<Q", shstr_e, 24)[0]
    shstr_sz = struct.unpack_from("<Q", shstr_e, 32)[0]

    # 算 .codesign 段文件偏移: 所有段末尾 max(e_shoff+e_shnum*64, 各段 off+size) + 4KB 对齐
    cur_end = e_shoff + e_shnum * 64
    for i in range(e_shnum):
        e = raw[e_shoff + i * 64 : e_shoff + (i + 1) * 64]
        off = struct.unpack_from("<Q", e, 24)[0]
        sz = struct.unpack_from("<Q", e, 32)[0]
        if struct.unpack_from("<I", e, 4)[0] == 8:  # SHT_NOBITS (.bss) 不占文件
            sz = 0
        if off + sz > cur_end:
            cur_end = off + sz
    cs_off = (cur_end + PAGE_SIZE - 1) // PAGE_SIZE * PAGE_SIZE

    # 新 shstrtab = 旧 + ".codesign\0"
    CS_NAME = b".codesign"
    new_shstr = raw[shstr_off : shstr_off + shstr_sz] + CS_NAME + b"\x00"
    cs_shname = shstr_sz  # .codesign 名字在新 shstrtab 内偏移
    new_shstr_sz = len(new_shstr)

    # 新 shstrtab 落段后; 新 SHT 落其后 8B 对齐
    new_shstr_off = cs_off + PAGE_SIZE
    new_sht_off = (new_shstr_off + new_shstr_sz + 7) // 8 * 8
    new_shnum = e_shnum + 1
    new_total = new_sht_off + new_shnum * 64

    buf = bytearray(new_total)
    # 1) 原内容
    buf[0:len(raw)] = raw
    # 2) .codesign 段内容 (4KB 全0, 已 calloc)
    # 3) 新 shstrtab
    buf[new_shstr_off : new_shstr_off + new_shstr_sz] = new_shstr
    # 4) 旧 SHT 复制到新位置
    buf[new_sht_off : new_sht_off + e_shnum * 64] = raw[e_shoff : e_shoff + e_shnum * 64]
    # 5) 追加 .codesign entry (64B)
    cs_e = struct.pack(
        "<IIQQQQIIQQ",
        cs_shname,  # sh_name
        1,  # sh_type SHT_PROGBITS
        0,  # sh_flags
        0,  # sh_addr
        cs_off,  # sh_offset
        PAGE_SIZE,  # sh_size
        0, 0,  # sh_link, sh_info
        PAGE_SIZE,  # sh_addralign
        0,  # sh_entsize
    )
    buf[new_sht_off + e_shnum * 64 : new_sht_off + new_shnum * 64] = cs_e
    # 6) 改 shstrtab entry: 新 off + 新 size
    shstr_e_new = bytearray(
        buf[new_sht_off + e_shstrndx * 64 : new_sht_off + (e_shstrndx + 1) * 64]
    )
    shstr_e_new[24:32] = struct.pack("<Q", new_shstr_off)
    shstr_e_new[32:40] = struct.pack("<Q", new_shstr_sz)
    buf[new_sht_off + e_shstrndx * 64 : new_sht_off + (e_shstrndx + 1) * 64] = shstr_e_new
    # 7) 改 ELF header: e_shoff / e_shnum
    struct.pack_into("<Q", buf, E_SHOFF, new_sht_off)
    struct.pack_into("<H", buf, E_SHNUM, new_shnum)
    # e_shstrndx 不变

    return bytes(buf), cs_off


# ─────────────────────── merkle 树根哈希 ───────────────────────
def merkle_root_hash(data: bytes, cs_off: int, cs_len: int) -> bytes:
    """与上游 merkle_tree_builder.cpp::RunHashTask 等价:
    段所在页叶哈希全置0, 其余页正常SHA-256, 上推逐层照常."""
    if len(data) == 0:
        return sha256(bytes(PAGE_SIZE))

    npages = (len(data) + PAGE_SIZE - 1) // PAGE_SIZE
    cs_page_begin = cs_off // PAGE_SIZE
    cs_page_end = (cs_off + cs_len + PAGE_SIZE - 1) // PAGE_SIZE

    hashes = bytearray()
    for i in range(npages):
        if cs_len > 0 and cs_page_begin <= i < cs_page_end:
            hashes += bytes(HASH_OUT)  # 段所在页: 叶哈希置0
            continue
        page = data[i * PAGE_SIZE : (i + 1) * PAGE_SIZE]
        if len(page) < PAGE_SIZE:
            page = page + bytes(PAGE_SIZE - len(page))  # 末页补0
        hashes += sha256(page)

    if npages == 1:
        return hashes[:HASH_OUT]

    cur = bytes(hashes)
    while True:
        if len(cur) <= PAGE_SIZE:
            page = cur + bytes(PAGE_SIZE - len(cur))
            return sha256(page)
        nxt = bytearray()
        for i in range(0, len(cur), PAGE_SIZE):
            page = cur[i : i + PAGE_SIZE]
            if len(page) < PAGE_SIZE:
                page = page + bytes(PAGE_SIZE - len(page))
            nxt += sha256(page)
        cur = bytes(nxt)


# ─────────────────────── descriptor 与 ElfSignInfo ───────────────────────
def build_descriptor(sign_size: int, file_size: int, root: bytes,
                     flags: int) -> bytes:
    """descriptor 256 字节布局, 全小端 (文档 §4)."""
    d = bytearray(DESC_SIZE)
    d[0] = 1            # version
    d[1] = 1            # hashAlgorithm = SHA-256
    d[2] = 12           # log2BlockSize = 2^12 = 4096
    d[3] = 0            # saltSize
    d[4:8] = sign_size.to_bytes(4, "little")
    d[8:16] = file_size.to_bytes(8, "little")
    d[16:16 + 32] = root            # rootHash 左对齐填 64B, 后 32B 保持 0
    # d[80:112] salt 全 0
    d[112:116] = flags.to_bytes(4, "little")
    # d[116:120] reserved1=0
    # d[120:128] merkleTreeOffset=0
    # d[128:255] reserved2=0
    d[255] = 3          # csVersion
    return bytes(d)


# ─────────────────────────── 主流程 ───────────────────────────
def self_sign(in_path: str, out_path: str) -> None:
    with open(in_path, "rb") as f:
        raw = f.read()

    # 0. 前置校验: 已含 .codesign 段则拒签 (本工具只加签, 不剥旧段).
    #    反复签会累积段畸形, 验签侧按段名找到旧的不完整段会拒.
    #    需重签时请先 llvm-objcopy --remove-section .codesign <elf> 剥旧段.
    e_shoff = struct.unpack_from("<Q", raw, 0x28)[0]
    e_shnum = struct.unpack_from("<H", raw, 0x3c)[0]
    e_shstrndx = struct.unpack_from("<H", raw, 0x3e)[0]
    if e_shoff != 0 and e_shnum != 0 and e_shstrndx < e_shnum:
        shstr_e = raw[e_shoff + e_shstrndx * 64 : e_shoff + (e_shstrndx + 1) * 64]
        shstr_off = struct.unpack_from("<Q", shstr_e, 24)[0]
        shstr_sz = struct.unpack_from("<Q", shstr_e, 32)[0]
        if shstr_off + shstr_sz <= len(raw):
            for i in range(e_shnum):
                e = raw[e_shoff + i * 64 : e_shoff + (i + 1) * 64]
                name_off = struct.unpack_from("<I", e, 0)[0]
                if name_off < shstr_sz:
                    name = raw[shstr_off + name_off : shstr_off + shstr_sz].split(b"\x00")[0]
                    if name == b".codesign":
                        raise ValueError(
                            f"{in_path} already has a .codesign section.\n"
            "  This tool only adds a signature, it does not strip old ones.\n"
            "  To re-sign, first strip the old section with:\n"
            "    llvm-objcopy --remove-section .codesign {in_path}\n"
            "  then run self-sign again."
                        )

    # 1. 注入 4KB 占位 .codesign 段 → tmp
    tmp, cs_off = inject_codesign_section(raw)
    file_size = len(tmp)

    # 2. merkle 根哈希: 段所在页叶哈希置0
    root = merkle_root_hash(tmp, cs_off, PAGE_SIZE)

    # 3/4. descriptor with signSize=0 用于摘要
    desc_for_digest = build_descriptor(0, file_size, root, FLAG_SELF_SIGN)
    # 5. signature = SHA256(descriptor)
    signature = sha256(desc_for_digest)
    assert len(signature) == HASH_OUT
    # 6. descriptor with signSize=32 用于落盘
    desc_on_disk = build_descriptor(32, file_size, root, FLAG_SELF_SIGN)

    # 7. 拼 ElfSignInfo 头部 8B + descriptor 256B + signature 32B = 296B
    payload = bytearray()
    payload += FS_VERITY_DESCRIPTOR_TYPE.to_bytes(4, "little")  # type
    payload += (DESC_SIZE + HASH_OUT).to_bytes(4, "little")  # length = 288
    payload += desc_on_disk
    payload += signature

    # 8. 原地改写段内字节 (段从 cs_off 开始, 段内放 payload)
    tmp = bytearray(tmp)
    tmp[cs_off : cs_off + len(payload)] = payload

    # 9. 落盘
    with open(out_path, "wb") as f:
        f.write(tmp)

    print(f"self-sign ok: {in_path} → {out_path} (tmp={file_size}, cs_off=0x{cs_off:x}, payload={len(payload)})")


def main() -> int:
    if len(sys.argv) < 2 or len(sys.argv) > 3:
        sys.stderr.write(
            f"usage: {sys.argv[0]} <input_elf> [output_elf]\n"
            "  (output defaults to input, in-place)\n")
        return 1
    in_path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) == 3 else in_path
    try:
        self_sign(in_path, out_path)
    except (OSError, ValueError) as e:
        sys.stderr.write(f"error: {e}\n")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
