package com.poetry.learn;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * MainActivity - 接管 Android 返回键/手势返回
 *
 * 策略 (利用 WebView 自身 history 栈):
 *   - app.js 在导航进入新页 (openCategory/openAuthor/openPoem) 时调 history.pushState
 *   - 监听 popstate 事件自动切回上一页面
 *   - 这里只需要把 Android back 键转给 WebView:
 *       canGoBack()  -> webView.goBack()  (内部导航, 触发 popstate)
 *       !canGoBack() -> super.onBackPressed() (退出 App, 默认行为)
 *
 * 优点: 方案简洁, 不需要维护 JS 侧额外的 page stack,
 *       popstate 是浏览器原生机制, pushState/goBack 配合可靠.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onBackPressed() {
        WebView webView = this.bridge != null ? this.bridge.getWebView() : null;
        if (webView != null && webView.canGoBack()) {
            // WebView 有历史 -> 内部返回 (触发 JS popstate, 由 app.js 切回对应页)
            webView.goBack();
        } else {
            // 没有历史 -> 系统默认 (退出 App)
            super.onBackPressed();
        }
    }
}
