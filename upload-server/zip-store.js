/*
 * zip-store.js —— 极简 ZIP 打包器（只用「存储」方式，不压缩）
 *
 * 作用：把若干 Blob（例如分割好的分片）打成一个标准 ZIP 包，供浏览器直接下载。
 * 特点：
 *  - 不压缩（store / method 0），因此原文件多大，包就多大；对已经是压缩格式的文件（视频、zip、图片）没有损失，也不会浪费时间重压缩。
 *  - CRC32 分块流式计算，内存占用只跟单块读取大小有关（默认 4MB），不会把整个文件读进内存。
 *  - 支持 UTF-8 文件名（general purpose bit 11），中文名不会乱码。
 *  - 生成标准 ZIP，Windows/macOS/Linux 自带解压工具和手机解压 App 都能直接打开。
 *
 * 用法（浏览器与 Node 通用）：
 *   const blob = await window.ZipStore.buildZip([{ name: 'a.bin', blob }], { onProgress });
 *   const volumes = window.ZipStore.planVolumes(files, 100 * 1024 * 1024);
 */
(function (global) {
  'use strict';

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32Init() { return 0xFFFFFFFF; }

  function crc32Update(crc, bytes) {
    var c = crc;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return c >>> 0;
  }

  function crc32Final(crc) { return (crc ^ 0xFFFFFFFF) >>> 0; }

  function dosDateTime(date) {
    var d = date || new Date();
    var year = d.getFullYear() < 1980 ? 1980 : d.getFullYear();
    var time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
    var day = (((year - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
    return { time: time, date: day };
  }

  function writeU16(arr, off, v) {
    arr[off] = v & 0xFF;
    arr[off + 1] = (v >>> 8) & 0xFF;
  }

  function writeU32(arr, off, v) {
    arr[off] = v & 0xFF;
    arr[off + 1] = (v >>> 8) & 0xFF;
    arr[off + 2] = (v >>> 16) & 0xFF;
    arr[off + 3] = (v >>> 24) & 0xFF;
  }

  function totalBytes(files) {
    var sum = 0;
    for (var i = 0; i < files.length; i++) sum += files[i].blob.size;
    return sum;
  }

  /**
   * 把 files 打成一个 ZIP Blob。
   * @param {Array<{name:string, blob:Blob}>} files
   * @param {{onProgress?:function, readChunkBytes?:number, date?:Date}} [options]
   * @returns {Promise<Blob>}
   */
  async function buildZip(files, options) {
    options = options || {};
    var onProgress = options.onProgress || null;
    var readChunkBytes = options.readChunkBytes || 4 * 1024 * 1024;
    var encoder = new global.TextEncoder();
    var dt = dosDateTime(options.date);

    var total = totalBytes(files);
    var processed = 0;
    var pieces = [];
    var entries = [];
    var offset = 0;

    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var nameBytes = encoder.encode(String(f.name || 'file'));
      var blob = f.blob;

      // 分块读入，增量算 CRC32，避免整块文件进内存
      var crc = crc32Init();
      for (var p = 0; p < blob.size; p += readChunkBytes) {
        var end = Math.min(p + readChunkBytes, blob.size);
        var slice = blob.slice(p, end);
        var buf = await slice.arrayBuffer();
        crc = crc32Update(crc, new Uint8Array(buf));
        processed += end - p;
        if (onProgress) onProgress(processed, total, f.name);
      }
      var crcValue = crc32Final(crc);
      var size = blob.size;

      var local = new Uint8Array(30 + nameBytes.length);
      writeU32(local, 0, 0x04034b50);
      writeU16(local, 4, 20);        // 解压所需版本 2.0
      writeU16(local, 6, 0x0800);    // bit 11：文件名为 UTF-8
      writeU16(local, 8, 0);         // 存储（不压缩）
      writeU16(local, 10, dt.time);
      writeU16(local, 12, dt.date);
      writeU32(local, 14, crcValue);
      writeU32(local, 18, size);
      writeU32(local, 22, size);
      writeU16(local, 26, nameBytes.length);
      writeU16(local, 28, 0);
      local.set(nameBytes, 30);

      pieces.push(local, blob);
      entries.push({ nameBytes: nameBytes, crc: crcValue, size: size, offset: offset });
      offset += local.length + size;
    }

    var centralStart = offset;
    var centralSize = 0;
    for (var e = 0; e < entries.length; e++) {
      var entry = entries[e];
      var cd = new Uint8Array(46 + entry.nameBytes.length);
      writeU32(cd, 0, 0x02014b50);
      writeU16(cd, 4, 20);           // version made by
      writeU16(cd, 6, 20);           // version needed
      writeU16(cd, 8, 0x0800);
      writeU16(cd, 10, 0);
      writeU16(cd, 12, dt.time);
      writeU16(cd, 14, dt.date);
      writeU32(cd, 16, entry.crc);
      writeU32(cd, 20, entry.size);
      writeU32(cd, 24, entry.size);
      writeU16(cd, 28, entry.nameBytes.length);
      writeU16(cd, 30, 0);           // extra
      writeU16(cd, 32, 0);           // comment
      writeU16(cd, 34, 0);           // disk start
      writeU16(cd, 36, 0);           // internal attrs
      writeU32(cd, 38, 0);           // external attrs
      writeU32(cd, 42, entry.offset);
      cd.set(entry.nameBytes, 46);
      pieces.push(cd);
      centralSize += cd.length;
    }

    var eocd = new Uint8Array(22);
    writeU32(eocd, 0, 0x06054b50);
    writeU16(eocd, 4, 0);
    writeU16(eocd, 6, 0);
    writeU16(eocd, 8, entries.length);
    writeU16(eocd, 10, entries.length);
    writeU32(eocd, 12, centralSize);
    writeU32(eocd, 16, centralStart);
    writeU16(eocd, 20, 0);
    pieces.push(eocd);

    return new global.Blob(pieces, { type: 'application/zip' });
  }

  /**
   * 按累计原始大小把分片切分成若干卷。单卷超过上限时，至少放一个分片。
   * @param {Array<{name:string, blob:Blob}>} files
   * @param {number} maxBytes 每卷上限（0 或空表示不分卷）
   * @returns {Array<Array<{name:string, blob:Blob}>>}
   */
  function planVolumes(files, maxBytes) {
    if (!maxBytes || maxBytes <= 0) return [files];
    var volumes = [];
    var current = [];
    var currentSize = 0;
    for (var i = 0; i < files.length; i++) {
      var size = files[i].blob.size;
      if (current.length && currentSize + size > maxBytes) {
        volumes.push(current);
        current = [];
        currentSize = 0;
      }
      current.push(files[i]);
      currentSize += size;
    }
    if (current.length) volumes.push(current);
    return volumes;
  }

  global.ZipStore = {
    buildZip: buildZip,
    planVolumes: planVolumes,
    crc32Init: crc32Init,
    crc32Update: crc32Update,
    crc32Final: crc32Final,
  };
})(typeof window !== 'undefined' ? window : globalThis);
