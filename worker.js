/**
 * Cloudflare Worker 实现 IPFS 图床
 * 功能：图片上传、IPFS 固定、元数据存储（KV）、前端管理页面
 * 依赖：绑定 Cloudflare KV（命名空间：IPFS_GALLERY）
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // 前端页面路由（根路径返回 HTML）
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(HTML_TEMPLATE, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }

    // 图片上传接口
    if (request.method === 'POST' && url.pathname === '/upload') {
      return this.handleUpload(request, env);
    }

    // 图片列表接口
    if (request.method === 'GET' && url.pathname === '/images') {
      return this.handleListImages(env);
    }

    return new Response('Not Found', { status: 404 });
  },

  /**
   * 处理图片上传到 IPFS 并存储元数据
   */
  async handleUpload(request, env) {
    const formData = await request.formData();
    const file = formData.get('file');
    
    // 校验文件是否存在
    if (!file) {
      return new Response(JSON.stringify({ error: '未上传文件' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    try {
      // 上传到 Cloudflare IPFS 固定服务（修正 API 路径）
      const ipfsResponse = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ipfs/pins`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.CF_API_TOKEN}`,
            'Content-Type': file.type // 使用文件实际 MIME 类型
          },
          body: file
        }
      );

      // 解析 IPFS 响应
      const ipfsData = await ipfsResponse.json();
      if (!ipfsResponse.ok) {
        const errorMsg = ipfsData.errors?.[0]?.message || 'IPFS 上传失败';
        throw new Error(`IPFS 接口错误: ${errorMsg}`);
      }

      // 提取 CID 和文件信息
      const cid = ipfsData.result.cid;
      const fileName = file.name;
      const timestamp = Date.now();

      // 存储元数据到 Cloudflare KV（键：cid，值：文件信息）
      await env.IPFS_GALLERY.put(cid, JSON.stringify({
        cid,
        fileName,
        timestamp,
        size: file.size,
        mimeType: file.type,
        ipfsUrl: `https://${cid}.ipfs.cf-ipfs.com` // Cloudflare IPFS 网关 URL
      }));

      // 返回上传成功结果
      return new Response(JSON.stringify({
        success: true,
        cid,
        ipfsUrl: `https://${cid}.ipfs.cf-ipfs.com`,
        fileName
      }), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      // 捕获并返回错误信息
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  /**
   * 获取已上传图片列表（从 KV 读取）
   */
  async handleListImages(env) {
    const { keys } = await env.IPFS_GALLERY.list();
    const images = [];
    
    // 遍历 KV 键获取所有图片元数据
    for (const key of keys) {
      const imageData = await env.IPFS_GALLERY.get(key.name);
      images.push(JSON.parse(imageData));
    }

    // 按上传时间倒序排序（最新在前）
    images.sort((a, b) => b.timestamp - a.timestamp);

    return new Response(JSON.stringify(images), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

/**
 * 前端 HTML 模板（嵌入 Worker 中）
 */
const HTML_TEMPLATE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IPFS 图床 - Cloudflare Worker</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .drop-zone { border: 2px dashed #e5e7eb; transition: all 0.3s; }
    .drop-zone.active { border-color: #3b82f6; background: #f3f4f6; }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">
  <div class="container mx-auto p-4 max-w-3xl">
    <h1 class="text-2xl font-bold text-gray-900 mb-8 text-center">IPFS 图床</h1>

    <!-- 上传区域 -->
    <div class="bg-white rounded-lg shadow-md p-6 mb-8">
      <div class="drop-zone p-8 text-center">
        <p class="text-gray-600 mb-4">拖动文件到此处上传，或点击选择文件</p>
        <input type="file" accept="image/*" id="fileInput" class="hidden">
        <button id="selectBtn" class="bg-blue-500 text-white px-6 py-2 rounded hover:bg-blue-600 transition-colors">
          选择图片
        </button>
      </div>
      <div id="uploadStatus" class="mt-4 text-sm text-red-500"></div>
    </div>

    <!-- 图片列表 -->
    <div class="bg-white rounded-lg shadow-md p-6">
      <h2 class="text-lg font-semibold text-gray-800 mb-4">已上传图片</h2>
      <div id="imageList" class="grid grid-cols-1 md:grid-cols-2 gap-4"></div>
    </div>
  </div>

  <script>
    //  DOM 元素引用
    const dropZone = document.querySelector('.drop-zone');
    const fileInput = document.getElementById('fileInput');
    const selectBtn = document.getElementById('selectBtn');
    const uploadStatus = document.getElementById('uploadStatus');
    const imageList = document.getElementById('imageList');

    // 初始化：加载已上传图片
    loadImages();

    // 拖拽事件处理
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
      dropZone.addEventListener(eventName, preventDefaults);
      document.body.addEventListener(eventName, preventDefaults);
    });

    ['dragenter', 'dragover'].forEach(eventName => {
      dropZone.addEventListener(eventName, () => dropZone.classList.add('active'));
    });

    ['dragleave', 'drop'].forEach(eventName => {
      dropZone.addEventListener(eventName, () => dropZone.classList.remove('active'));
    });

    // 按钮点击事件：触发文件选择框
    selectBtn.addEventListener('click', () => fileInput.click());

    // 文件选择/拖拽后的上传逻辑
    fileInput.addEventListener('change', handleFileSelect);
    dropZone.addEventListener('drop', handleDrop);

    // 处理文件拖拽上传
    function handleDrop(e) {
      const files = e.dataTransfer.files;
      if (files.length > 0) uploadFiles(files);
    }

    // 处理文件选择上传
    function handleFileSelect(e) {
      const files = e.target.files;
      if (files.length > 0) uploadFiles(files);
    }

    // 上传文件到 Worker 接口
    async function uploadFiles(files) {
      const file = files[0];
      uploadStatus.textContent = `正在上传：${file.name}...`;
      
      try {
        const formData = new FormData();
        formData.append('file', file);
        
        const response = await fetch('/upload', {
          method: 'POST',
          body: formData
        });
        
        const result = await response.json();
        if (result.success) {
          uploadStatus.textContent = `上传成功！IPFS 链接：${result.ipfsUrl}`;
          uploadStatus.classList.remove('text-red-500');
          uploadStatus.classList.add('text-green-500');
          loadImages(); // 刷新图片列表
        } else {
          uploadStatus.textContent = `上传失败：${result.error}`;
          uploadStatus.classList.add('text-red-500');
        }
      } catch (error) {
        uploadStatus.textContent = `上传错误：${error.message}`;
        uploadStatus.classList.add('text-red-500');
      }
    }

    // 加载并渲染图片列表
    async function loadImages() {
      try {
        const response = await fetch('/images');
        const images = await response.json();
        
        imageList.innerHTML = images.map(img => `
          <div class="border rounded p-3 shadow-sm">
            <div class="text-sm text-gray-600 mb-2">
              ${img.fileName} · ${new Date(img.timestamp).toLocaleString()}
            </div>
            <img src="${img.ipfsUrl}" alt="${img.fileName}" 
                 class="w-full h-48 object-cover rounded-sm bg-gray-100">
            <div class="mt-2 flex gap-2">
              <input type="text" value="${img.ipfsUrl}" 
                     class="flex-1 p-1 border rounded text-sm" 
                     readonly>
              <button class="px-2 py-1 bg-blue-500 text-white text-sm rounded 
                           hover:bg-blue-600 transition-colors" 
                      onclick="copyText(this.previousElementSibling)">
                复制链接
              </button>
            </div>
          </div>
        `).join('');
      } catch (error) {
        imageList.innerHTML = `<div class="text-red-500">加载图片失败：${error.message}</div>`;
      }
    }

    // 复制链接到剪贴板
    function copyText(input) {
      input.select();
      document.execCommand('copy');
      alert('链接已复制到剪贴板');
    }

    // 阻止默认拖拽行为
    function preventDefaults(e) {
      e.preventDefault();
      e.stopPropagation();
    }
  </script>
</body>
</html>
    `
