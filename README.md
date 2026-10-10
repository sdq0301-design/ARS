# Auto Reply Support (Userscript)

Tự động trả lời chat đang ở trạng thái **Assigned** trên Omni Support
("Chào bạn" nếu khách viết tiếng Việt, "Hi" nếu tiếng Anh).

## Cài đặt
1. Cài [Tampermonkey](https://www.tampermonkey.net/) cho Chrome.
2. Bật **Developer mode** trong `chrome://extensions` (Tampermonkey mới yêu cầu bước này).
3. Mở link raw của file `auto-reply.user.js` trên GitHub, Tampermonkey sẽ hiện trang cài đặt, bấm **Install**.
4. Mở `https://omnisupport.fpt.ai/`, bấm nút **Auto Reply: OFF** ở góc dưới-trái để bật.

## Cho tab chạy ổn định ở nền
- `chrome://settings/performance` -> Memory Saver -> thêm `omnisupport.fpt.ai` vào danh sách "luôn giữ hoạt động".
- Để tab Omni Support ở cửa sổ riêng, không thu nhỏ.

## Tự động cập nhật
Thêm 2 dòng sau vào phần header của file (thay USER/REPO):

    // @updateURL    https://raw.githubusercontent.com/USER/REPO/main/auto-reply.user.js
    // @downloadURL  https://raw.githubusercontent.com/USER/REPO/main/auto-reply.user.js

Mỗi lần sửa code, nhớ tăng `@version`.
