// Browser CPU implementation of the local morph renderer. The caller owns the
// opaque RGBA input buffers until morph_close and provides a fresh output buffer.
#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/video/tracking.hpp>
#include <opencv2/features.hpp>
#include <opencv2/geometry/2d.hpp>
#include <opencv2/geometry/3d.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <map>
#include <memory>
#include <utility>
#include <vector>

namespace {
constexpr int flowEdge = 896;
using cv::Mat;
using cv::Point2f;
using cv::Size;
using cv::Vec2f;

Size analysisSize(Size size, int minimum) {
    double k = std::min(1.0, double(flowEdge) / std::max(size.width, size.height));
    return {std::max(minimum, cvRound(size.width * k)),
            std::max(minimum, cvRound(size.height * k))};
}

Mat grayAtSize(const Mat& rgba, Size size) {
    Mat small, gray;
    cv::resize(rgba, small, size, 0, 0, cv::INTER_AREA);
    cv::cvtColor(small, gray, cv::COLOR_RGBA2GRAY);
    return gray;
}

Mat makeGrid(Size size) {
    Mat grid(size, CV_32FC2);
    for (int y = 0; y < grid.rows; ++y) {
        Vec2f* row = grid.ptr<Vec2f>(y);
        for (int x = 0; x < grid.cols; ++x) row[x] = Vec2f(float(x), float(y));
    }
    return grid;
}

Mat sampleAt(const Mat& image, const Mat& coordinates) {
    Mat out;
    cv::remap(image, out, coordinates, cv::noArray(), cv::INTER_LINEAR, cv::BORDER_REPLICATE);
    return out;
}

Mat trackConfidence(const Mat& grid, const Mat& there, const Mat& back) {
    Mat at = grid + there;
    Mat sampled = sampleAt(back, at);
    Mat score(grid.size(), CV_32F);
    for (int y = 0; y < grid.rows; ++y) {
        const Vec2f* p = at.ptr<Vec2f>(y);
        const Vec2f* f = there.ptr<Vec2f>(y);
        const Vec2f* r = sampled.ptr<Vec2f>(y);
        float* out = score.ptr<float>(y);
        for (int x = 0; x < grid.cols; ++x) {
            Vec2f d = f[x] + r[x];
            float tolerance = 1.3f + 0.10f * std::sqrt(f[x].dot(f[x]));
            bool inside = p[x][0] >= 0 && p[x][0] <= grid.cols - 1 &&
                          p[x][1] >= 0 && p[x][1] <= grid.rows - 1;
            out[x] = (inside ? 1.0f : 0.25f) / (1.0f + d.dot(d) / (tolerance * tolerance));
        }
    }
    cv::GaussianBlur(score, score, Size(), 1);
    return score;
}

void shortenUncertainTracks(Mat& flow, const Mat& confidence) {
    for (int y = 0; y < flow.rows; ++y) {
        Vec2f* f = flow.ptr<Vec2f>(y);
        const float* c = confidence.ptr<float>(y);
        for (int x = 0; x < flow.cols; ++x) f[x] *= 0.35f + 0.65f * c[x];
    }
}

struct Transition {
    Mat a, b;
    Transition(const Mat& first, const Mat& last) : a(first), b(last) {}
    virtual ~Transition() = default;
    virtual void render(double t, Mat& output) {
        cv::addWeighted(a, 1 - t, b, t, 0, output);
    }
};

struct Flow : Transition {
    Mat grid, ab, ba, ca, cb;

    Flow(const Mat& a, const Mat& b) : Transition(a, b) {
        Size size = analysisSize(a.size(), 2);
        grid = makeGrid(size);
        Mat ga, gb;
        auto equalizer = cv::createCLAHE(2.0, Size(8, 8));
        equalizer->apply(grayAtSize(a, size), ga);
        equalizer->apply(grayAtSize(b, size), gb);
        int pad = 16;
        cv::copyMakeBorder(ga, ga, pad, pad, pad, pad, cv::BORDER_REFLECT101);
        cv::copyMakeBorder(gb, gb, pad, pad, pad, pad, cv::BORDER_REFLECT101);
        auto dis = cv::DISOpticalFlow::create(cv::DISOpticalFlow::PRESET_MEDIUM);
        cv::Rect interior(pad, pad, size.width, size.height);
        Mat forward, backward;
        dis->calc(ga, gb, forward);
        dis->calc(gb, ga, backward);
        ab = forward(interior).clone();
        ba = backward(interior).clone();
        ca = trackConfidence(grid, ab, ba);
        cb = trackConfidence(grid, ba, ab);
        shortenUncertainTracks(ab, ca);
        shortenUncertainTracks(ba, cb);
    }

    Mat inverse(const Mat& flow, const Mat& reverse, double amount) const {
        Mat delta;
        cv::addWeighted(reverse, amount * amount, flow, -amount * (1 - amount), 0, delta);
        // Solve source + amount * flow(source) = output, just as in the native renderer.
        for (int i = 0; i < 2; ++i) {
            Mat target = sampleAt(flow, grid + delta);
            cv::addWeighted(delta, 0.30, target, -0.70 * amount, 0, delta);
        }
        return delta;
    }

    Mat warp(const Mat& image, const Mat& delta) const {
        Mat at;
        cv::resize(delta, at, image.size(), 0, 0, cv::INTER_LINEAR);
        float sx = float(image.cols) / grid.cols, sy = float(image.rows) / grid.rows;
        for (int y = 0; y < at.rows; ++y) {
            Vec2f* p = at.ptr<Vec2f>(y);
            for (int x = 0; x < at.cols; ++x) {
                p[x][0] = x + sx * p[x][0];
                p[x][1] = y + sy * p[x][1];
            }
        }
        return sampleAt(image, at);
    }

    void render(double t, Mat& output) override {
        Mat da = inverse(ab, ba, t), db = inverse(ba, ab, 1 - t);
        Mat weightA = sampleAt(ca, grid + da), weightB = sampleAt(cb, grid + db);
        for (int y = 0; y < grid.rows; ++y) {
            const float* left = weightA.ptr<float>(y);
            float* right = weightB.ptr<float>(y);
            for (int x = 0; x < grid.cols; ++x) {
                float l = float(1-t) * (0.35f + 0.65f * left[x]);
                float r = float(t) * (0.35f + 0.65f * right[x]);
                right[x] = r / (l + r);
            }
        }
        Mat full;
        cv::resize(weightB, full, a.size(), 0, 0, cv::INTER_LINEAR);
        cv::blendLinear(warp(a, da), warp(b, db), 1.0 - full, full, output);
    }
};

std::vector<int> distinctMatches(const Mat& from, const Mat& to) {
    cv::BFMatcher matcher(cv::NORM_L2);
    std::vector<std::vector<cv::DMatch>> neighbors;
    matcher.knnMatch(from, to, neighbors, 2);
    std::vector<int> result(from.rows, -1);
    for (const auto& pair : neighbors) {
        if (pair.size() == 2 && pair[0].distance < 0.80f * pair[1].distance)
            result[pair[0].queryIdx] = pair[0].trainIdx;
    }
    return result;
}

Mat registerCamera(const Mat& a, const Mat& b) {
    Size size = analysisSize(a.size(), 1);
    if (std::min(size.width, size.height) < 20) return {};
    auto sift = cv::SIFT::create(1600, 3, 0.025);
    std::vector<cv::KeyPoint> keyA, keyB;
    Mat sa, sb;
    sift->detectAndCompute(grayAtSize(a, size), cv::noArray(), keyA, sa);
    sift->detectAndCompute(grayAtSize(b, size), cv::noArray(), keyB, sb);
    if (std::min(keyA.size(), keyB.size()) < 8) return {};

    auto forward = distinctMatches(sa, sb), backward = distinctMatches(sb, sa);
    // Count unique image locations, ignoring SIFT's extra orientations at a corner.
    std::map<std::pair<int,int>, std::pair<Point2f,Point2f>> pairs;
    for (size_t i = 0; i < forward.size(); ++i) {
        int j = forward[i];
        if (j < 0 || backward[j] != int(i)) continue;
        Point2f p = keyA[i].pt;
        pairs.emplace(std::make_pair(cvRound(p.x), cvRound(p.y)),
                      std::make_pair(p, keyB[j].pt));
    }
    if (pairs.size() < 8) return {};
    auto full = [&](Point2f p) {
        return Point2f((double(p.x) + 0.5) * a.cols / size.width - 0.5,
                       (double(p.y) + 0.5) * a.rows / size.height - 0.5);
    };
    std::vector<Point2f> x, y;
    for (const auto& item : pairs) {
        x.push_back(full(item.second.first));
        y.push_back(full(item.second.second));
    }
    double scale = std::min(1.0, double(flowEdge) / std::max(a.cols, a.rows));
    double tolerance = std::max(2.0, 0.005 * std::hypot(size.width, size.height)) / scale;
    Mat inlier;
    Mat model = cv::estimateAffinePartial2D(x, y, inlier, cv::RANSAC, tolerance, 2000, 0.995, 15);
    if (model.empty() || !cv::checkRange(model)) return {};
    std::vector<Point2f> inA, inB, hull;
    for (size_t i = 0; i < x.size(); ++i) {
        if (inlier.ptr<uchar>()[i]) {
            inA.push_back(x[i]);
            inB.push_back(y[i]);
        }
    }
    if (inA.size() < 8 || inA.size() < 0.45 * pairs.size()) return {};
    for (const auto* p : {&inA, &inB}) {
        cv::convexHull(*p, hull);
        if (cv::contourArea(hull) < 0.04 * a.cols * a.rows) return {};
    }
    if (std::hypot(model.at<double>(0,0), model.at<double>(1,0)) < 1e-6) return {};
    return model;
}

struct Camera : Transition {
    cv::Vec2d center, shift;
    double angle, logScale;
    cv::Matx33d toFirst;
    Mat coverage;

    Camera(const Mat& a, const Mat& b, const Mat& matrix) : Transition(a,b) {
        auto m = cv::Matx23d(matrix);
        center = {(a.cols - 1) * 0.5, (a.rows - 1) * 0.5};
        cv::Vec3d homogeneous(center[0], center[1], 1);
        shift = m * homogeneous - center;
        angle = std::atan2(m(1,0), m(0,0));
        logScale = std::log(std::hypot(m(0,0), m(1,0)));
        cv::Matx33d transform(m(0,0), m(0,1), m(0,2), m(1,0), m(1,1), m(1,2), 0, 0, 1);
        toFirst = transform.inv();
        coverage = Mat(a.size(), CV_8U, cv::Scalar(255));
    }

    void render(double t, Mat& output) override {
        double scale = std::exp(t * logScale);
        double c = scale * std::cos(t * angle), s = scale * std::sin(t * angle);
        cv::Vec2d offset = center + t * shift - cv::Matx22d(c, -s, s, c) * center;
        cv::Matx23d fromA(c, -s, offset[0], s, c, offset[1]);
        cv::Matx23d fromB = fromA * toFirst;
        Mat wa, wb, imageA, imageB;
        cv::warpAffine(coverage, wa, fromA, a.size());
        cv::warpAffine(coverage, wb, fromB, a.size());
        Mat weight(a.size(), CV_32F);
        for (int y = 0; y < weight.rows; ++y) {
            const uchar* left = wa.ptr<uchar>(y);
            const uchar* right = wb.ptr<uchar>(y);
            float* out = weight.ptr<float>(y);
            for (int x = 0; x < weight.cols; ++x) {
                float l = float(1 - t) * left[x], r = float(t) * right[x];
                out[x] = l + r > 0 ? r / (l + r) : float(t);
            }
        }
        cv::warpAffine(a, imageA, fromA, a.size(), cv::INTER_LINEAR, cv::BORDER_REPLICATE);
        cv::warpAffine(b, imageB, fromB, a.size(), cv::INTER_LINEAR, cv::BORDER_REPLICATE);
        cv::blendLinear(imageA, imageB, 1.0 - weight, weight, output);
    }
};
}  // namespace

extern "C" {
void* morph_prepare(unsigned char* a, unsigned char* b, int width, int height, int method) {
    if (!a || !b || width <= 0 || height <= 0) return nullptr;
    try {
        Mat first(height, width, CV_8UC4, a), last(height, width, CV_8UC4, b);
        if (method == 1 && std::min(width, height) >= 16) return new Flow(first, last);
        if (method == 2) {
            Mat matrix = registerCamera(first, last);
            if (!matrix.empty()) return new Camera(first, last, matrix);
        }
        return new Transition(first, last);
    } catch (...) {
        return nullptr;
    }
}

int morph_frame(void* handle, double t, unsigned char* rgba) {
    if (!handle || !rgba || !std::isfinite(t) || t < 0 || t > 1) return 0;
    try {
        auto* state = static_cast<Transition*>(handle);
        Mat output(state->a.size(), CV_8UC4, rgba);
        if (t == 0) state->a.copyTo(output);
        else if (t == 1) state->b.copyTo(output);
        else state->render(t, output);
        return 1;
    } catch (...) {
        return 0;
    }
}

void morph_close(void* handle) {
    delete static_cast<Transition*>(handle);
}
}
