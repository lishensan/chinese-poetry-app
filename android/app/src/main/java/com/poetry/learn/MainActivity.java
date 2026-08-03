package com.poetry.learn;

import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;

import com.getcapacitor.BridgeActivity;

/**
 * 主界面.
 *
 * <p>返回手势兼容说明 (targetSdk=34, minSdk=22):
 * <ul>
 *   <li>API 33+: 通过 {@link OnBackInvokedCallback} 接管物理返回键 + 侧滑预测性手势,
 *       全部走 {@code webView.goBack()} / {@code finish()}, 与历史栈深度解耦.</li>
 *   <li>API 22-32: 保留旧 {@code onBackPressed()} 兜底, 行为一致.</li>
 * </ul>
 *
 * <p>WebView 的导航栈由前端 {@code history.pushState}/{@code history.popstate} 维护.
 *   当栈深度 &gt; 0 时, 系统返回触发 {@code webView.goBack()},
 *   内部即触发 popstate, 前端根据 state.page 切回对应页.
 */
public class MainActivity extends BridgeActivity {

    private static final String TAG = "PoetryApp";

    /** API 33+ 侧滑/物理返回回调. */
    @Nullable
    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    private OnBackInvokedCallback mBackInvokedCallback;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Log.d(TAG, "onCreate done sdk=" + Build.VERSION.SDK_INT);
        registerBackCallback();
    }

    /**
     * 注册预测性返回 (API 33+).
     * 使用 {@link OnBackInvokedDispatcher#PRIORITY_OVERLAY} 以保证在大多数 web 内容前拿到回调.
     */
    private void registerBackCallback() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            OnBackInvokedCallback callback = new OnBackInvokedCallback() {
                @Override
                public void onBackInvoked() {
                    handleBackPressed();
                }
            };
            OnBackInvokedDispatcher dispatcher = getOnBackInvokedDispatcher();
            if (dispatcher != null) {
                dispatcher.registerOnBackInvokedCallback(
                        OnBackInvokedDispatcher.PRIORITY_OVERLAY, callback);
                mBackInvokedCallback = callback;
                Log.d(TAG, "OnBackInvokedCallback registered");
            } else {
                Log.w(TAG, "OnBackInvokedDispatcher is null, fallback to onBackPressed");
            }
        }
    }

    /**
     * 统一处理返回: WebView 可后退 -> goBack, 否则 finish.
     * 该方法在 {@code onBackPressed} 和 {@code OnBackInvokedCallback} 都会被调用.
     */
    private void handleBackPressed() {
        WebView webView = this.bridge != null ? this.bridge.getWebView() : null;
        boolean canBack = webView != null && webView.canGoBack();
        Log.d(TAG, "handleBackPressed webView=" + (webView != null)
                + " canGoBack=" + canBack
                + " historyLen=" + (webView != null ? webView.copyBackForwardList().getSize() : -1));
        if (canBack) {
            webView.goBack();
        } else {
            // 退出 App (区别于 super.onBackPressed, 在 API 33+ 也可显式 finish)
            finish();
        }
    }

    @Override
    public void onBackPressed() {
        // API 22-32 走这里; API 33+ 一般走 OnBackInvokedCallback,
        // 但系统仍会回调 onBackPressed 作为兜底.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            handleBackPressed();
        } else {
            // 33+: 若 dispatcher 未生效 (例如某些 ROM), 兜底走原逻辑
            WebView webView = this.bridge != null ? this.bridge.getWebView() : null;
            if (webView != null && webView.canGoBack()) {
                webView.goBack();
            } else {
                super.onBackPressed();
            }
        }
    }

    @Override
    public void onDestroy() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && mBackInvokedCallback != null) {
            OnBackInvokedDispatcher dispatcher = getOnBackInvokedDispatcher();
            if (dispatcher != null) {
                try {
                    dispatcher.unregisterOnBackInvokedCallback(mBackInvokedCallback);
                    Log.d(TAG, "OnBackInvokedCallback unregistered");
                } catch (Throwable t) {
                    Log.w(TAG, "unregisterOnBackInvokedCallback failed", t);
                }
            }
            mBackInvokedCallback = null;
        }
        super.onDestroy();
    }
}
